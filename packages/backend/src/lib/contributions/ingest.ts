import type { GhCommitSummary, GhRepo, GitHubSource } from './github.js';
import { countCoAuthors, POLICY_VERSION, totalFiles } from './policy.js';

/**
 * Contribution ingestion (#546, epic #544): a paginated, resumable, single-writer read of a project's default-branch
 * history into `project_commits`.
 *
 * Guarantees:
 *  - Facts are keyed by (immutable GitHub repo id, SHA). A replayed run, a concurrent worker or a renamed repository
 *    cannot count a commit twice.
 *  - The repository is DERIVED from the app (`proappstore-online/<app>`, or a pinned transferred one). It is never
 *    taken from a caller. Its immutable id is recorded on first sight; a different id under the same name stops
 *    ingestion as `identity_changed` and is never silently re-bound.
 *  - A run does bounded work (a per-run budget of commit-detail fetches) and checkpoints after every page, so it
 *    resumes where it stopped. The commit list is pinned to the head SHA the walk started from, so new pushes during
 *    a multi-run backfill cannot shift pages.
 *  - Rate limits, revoked access and transient errors are recorded as such. They never become a zero and never mark
 *    a backfill complete.
 *  - A history rewrite or a default-branch change triggers a full walk; commits no longer reachable are marked
 *    unreachable (kept as audit facts, excluded from aggregates).
 */

const APP_ORG = 'proappstore-online';
/** Apps whose repository is not `proappstore-online/<id>`. Mirrors the pinned deploy identity in app-deploy-oidc.ts. */
const PINNED_REPOSITORIES: Readonly<Record<string, string>> = { 'chess-academy': 'ChessClubs-online/chess-clubs' };

const PAGE_SIZE = 100;
const DETAIL_BUDGET = 40;
const LEASE_MS = 4 * 60_000;
const REFRESH_MS = 15 * 60_000;
const INCOMPLETE_RETRY_MS = 60_000;
const ERROR_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];

export function projectRepository(appId: string): { fullName: string; source: 'convention' | 'pinned' } {
  const pinned = PINNED_REPOSITORIES[appId];
  return pinned ? { fullName: pinned, source: 'pinned' } : { fullName: `${APP_ORG}/${appId}`, source: 'convention' };
}

export interface IngestOptions { now?: number; budget?: number; pageSize?: number; force?: boolean }
export type IngestOutcome =
  | 'complete' | 'budget_exhausted' | 'rate_limited' | 'access_lost' | 'identity_changed' | 'transient_error' | 'busy' | 'unavailable';

interface SyncRow {
  github_repo_id: number | null; head_sha: string | null; default_branch: string | null; backfill_complete: number; policy_version: number;
  walk_id: string | null; walk_head_sha: string | null; walk_page: number; walk_full: number; error_count: number;
}

const uuid = () => crypto.randomUUID();

async function event(db: D1Database, appId: string, repoId: number | null, action: string, detail: string | null, now: number) {
  await db.prepare('INSERT INTO project_contribution_events (id, app_id, github_repo_id, action, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(uuid(), appId, repoId, action, detail, now).run();
}

/** Create the binding and sync rows if absent. Idempotent; never changes an existing binding. */
export async function ensureProject(db: D1Database, appId: string, now: number): Promise<void> {
  const { fullName, source } = projectRepository(appId);
  // Two independent idempotent inserts: each is safe to repeat and to race, so no transaction is needed.
  await db.prepare('INSERT OR IGNORE INTO project_repositories (app_id, full_name, source, status, created_at, updated_at) VALUES (?1, ?2, ?3, \'pending\', ?4, ?4)').bind(appId, fullName, source, now).run();
  await db.prepare('INSERT OR IGNORE INTO project_contribution_sync (app_id, policy_version, state, updated_at) VALUES (?1, ?2, \'idle\', ?3)').bind(appId, POLICY_VERSION, now).run();
}

async function claim(db: D1Database, appId: string, now: number): Promise<boolean> {
  const r = await db.prepare('UPDATE project_contribution_sync SET lease_until = ?2, state = \'running\', last_attempt_at = ?3, updated_at = ?3 WHERE app_id = ?1 AND (lease_until IS NULL OR lease_until < ?3)')
    .bind(appId, now + LEASE_MS, now).run();
  return (r.meta?.changes ?? 0) > 0;
}

async function release(db: D1Database, appId: string, state: 'idle' | 'complete' | 'incomplete' | 'error', patch: { error?: string | null; nextRefreshAt: number; rateLimitedUntil?: number | null; resetErrors?: boolean; success?: boolean }, now: number) {
  await db.prepare(
    `UPDATE project_contribution_sync SET lease_until = NULL, state = ?2, last_error = ?3, next_refresh_at = ?4, rate_limited_until = ?5,
       error_count = CASE WHEN ?6 = 1 THEN 0 WHEN ?3 IS NOT NULL THEN error_count + 1 ELSE error_count END,
       last_success_at = CASE WHEN ?7 = 1 THEN ?8 ELSE last_success_at END, updated_at = ?8 WHERE app_id = ?1`,
  ).bind(appId, state, patch.error ?? null, patch.nextRefreshAt, patch.rateLimitedUntil ?? null, patch.resetErrors ? 1 : 0, patch.success ? 1 : 0, now).run();
}

const backoff = (errors: number) => ERROR_BACKOFF_MS[Math.min(errors, ERROR_BACKOFF_MS.length - 1)]!;

/** Read (or continue reading) one app's default-branch history. Safe to call concurrently and repeatedly. */
export async function refreshProject(db: D1Database, gh: GitHubSource, appId: string, opts: IngestOptions = {}): Promise<IngestOutcome> {
  const now = opts.now ?? Date.now();
  await ensureProject(db, appId, now);
  if (!(await claim(db, appId, now))) return 'busy';

  try {
    const binding = (await db.prepare('SELECT full_name, github_repo_id, status FROM project_repositories WHERE app_id = ?1').bind(appId).first<{ full_name: string; github_repo_id: number | null; status: string }>())!;
    const sync = (await db.prepare('SELECT github_repo_id, head_sha, default_branch, backfill_complete, policy_version, walk_id, walk_head_sha, walk_page, walk_full, error_count FROM project_contribution_sync WHERE app_id = ?1').bind(appId).first<SyncRow>())!;

    const repoRes = await gh.getRepo(binding.full_name);
    if (!repoRes.ok) return await failed(db, appId, repoRes, sync, binding.github_repo_id, now);
    const repo = repoRes.repo;

    if (binding.github_repo_id !== null && binding.github_repo_id !== repo.id) {
      await db.prepare('UPDATE project_repositories SET status = \'identity_changed\', status_detail = ?2, updated_at = ?3 WHERE app_id = ?1')
        .bind(appId, `${binding.full_name} now resolves to a different repository id`, now).run();
      await event(db, appId, binding.github_repo_id, 'identity_changed', `expected id ${binding.github_repo_id}, found ${repo.id}`, now);
      await release(db, appId, 'error', { error: 'identity_changed', nextRefreshAt: now + backoff(3) }, now);
      return 'identity_changed';
    }
    if (binding.github_repo_id === null) {
      await event(db, appId, repo.id, 'bound', binding.full_name, now);
    }
    await db.prepare('UPDATE project_repositories SET github_repo_id = ?2, default_branch = ?3, status = \'verified\', status_detail = NULL, verified_at = ?4, updated_at = ?4 WHERE app_id = ?1')
      .bind(appId, repo.id, repo.defaultBranch, now).run();

    return await walk(db, gh, appId, repo, sync, opts, now);
  } catch (e) {
    await release(db, appId, 'error', { error: `unexpected: ${(e as Error).message.slice(0, 200)}`, nextRefreshAt: now + backoff(0) }, now).catch(() => undefined);
    return 'transient_error';
  }
}

async function failed(db: D1Database, appId: string, f: Extract<Awaited<ReturnType<GitHubSource['getRepo']>>, { ok: false }>, sync: SyncRow, repoId: number | null, now: number): Promise<IngestOutcome> {
  if (f.kind === 'rate_limited') {
    await event(db, appId, repoId, 'rate_limited', null, now);
    await release(db, appId, 'incomplete', { error: 'rate_limited', nextRefreshAt: f.retryAt, rateLimitedUntil: f.retryAt }, now);
    return 'rate_limited';
  }
  if (f.kind === 'access_lost') {
    await db.prepare('UPDATE project_repositories SET status = \'access_lost\', status_detail = \'the repository could not be read\', updated_at = ?2 WHERE app_id = ?1').bind(appId, now).run();
    await event(db, appId, repoId, 'access_lost', null, now);
    await release(db, appId, 'error', { error: 'access_lost', nextRefreshAt: now + backoff(3) }, now);
    return 'access_lost';
  }
  await release(db, appId, 'incomplete', { error: `transient: ${f.detail}`.slice(0, 200), nextRefreshAt: now + backoff(sync.error_count) }, now);
  return 'transient_error';
}

async function walk(db: D1Database, gh: GitHubSource, appId: string, repo: GhRepo, sync: SyncRow, opts: IngestOptions, now: number): Promise<IngestOutcome> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  let budget = opts.budget ?? DETAIL_BUDGET;

  let walkId = sync.walk_id;
  let page = sync.walk_page;
  let pinned = sync.walk_head_sha;
  let full = sync.walk_full === 1;
  const previousHead = sync.head_sha;

  if (walkId === null) {
    const branchChanged = sync.default_branch !== null && sync.default_branch !== repo.defaultBranch;
    if (branchChanged) await event(db, appId, repo.id, 'default_branch_changed', `${sync.default_branch} -> ${repo.defaultBranch}`, now);
    full = sync.backfill_complete === 0 || branchChanged || sync.policy_version !== POLICY_VERSION || opts.force === true || previousHead === null;
    walkId = uuid(); page = 1; pinned = null;
    await db.prepare('UPDATE project_contribution_sync SET github_repo_id = ?2, default_branch = ?3, walk_id = ?4, walk_page = 1, walk_head_sha = NULL, walk_full = ?5, policy_version = ?6, updated_at = ?7 WHERE app_id = ?1')
      .bind(appId, repo.id, repo.defaultBranch, walkId, full ? 1 : 0, POLICY_VERSION, now).run();
  }

  let reachedPreviousHead = false;
  for (;;) {
    const list = await gh.listCommits(repo.id, repo.fullName, pinned ?? repo.defaultBranch, page, pageSize);
    if (!list.ok) {
      if (list.kind === 'rate_limited') { await event(db, appId, repo.id, 'rate_limited', `page ${page}`, now); await release(db, appId, 'incomplete', { error: 'rate_limited', nextRefreshAt: list.retryAt, rateLimitedUntil: list.retryAt }, now); return 'rate_limited'; }
      if (list.kind === 'access_lost') return failed(db, appId, list, sync, repo.id, now);
      await release(db, appId, 'incomplete', { error: `transient: ${list.detail}`.slice(0, 200), nextRefreshAt: now + backoff(sync.error_count) }, now);
      return 'transient_error';
    }
    if (pinned === null && list.commits.length > 0) {
      pinned = list.commits[0]!.sha;
      await db.prepare('UPDATE project_contribution_sync SET walk_head_sha = ?2 WHERE app_id = ?1').bind(appId, pinned).run();
    }

    const known = await knownShas(db, repo.id, list.commits.map((c) => c.sha));
    for (const c of list.commits) {
      if (!full && previousHead !== null && c.sha === previousHead) { reachedPreviousHead = true; break; }
      const prior = known.get(c.sha);
      if (prior !== undefined && prior === POLICY_VERSION) {
        await db.prepare('UPDATE project_commits SET reachable = 1, walk_id = ?3 WHERE github_repo_id = ?1 AND sha = ?2').bind(repo.id, c.sha, walkId).run();
        continue;
      }
      if (c.parentCount > 1) { await saveCommit(db, appId, repo.id, c, walkId, now, { additions: 0, deletions: 0, filesCounted: 0, filesExcluded: 0 }, false, false); continue; }
      if (budget <= 0) return await pause(db, appId, page, now, 'budget_exhausted');
      budget--;
      const files = await gh.getCommitFiles(repo.id, repo.fullName, c.sha);
      if (!files.ok) {
        if (files.kind === 'rate_limited') { await event(db, appId, repo.id, 'rate_limited', `commit ${c.sha.slice(0, 7)}`, now); await release(db, appId, 'incomplete', { error: 'rate_limited', nextRefreshAt: files.retryAt, rateLimitedUntil: files.retryAt }, now); return 'rate_limited'; }
        if (files.kind === 'access_lost') return failed(db, appId, files, sync, repo.id, now);
        await release(db, appId, 'incomplete', { error: `transient: ${files.detail}`.slice(0, 200), nextRefreshAt: now + backoff(sync.error_count) }, now);
        return 'transient_error';
      }
      await saveCommit(db, appId, repo.id, c, walkId, now, totalFiles(files.files), true, files.truncated);
    }

    if (reachedPreviousHead || !list.hasNext || list.commits.length === 0) break;
    page++;
    await db.prepare('UPDATE project_contribution_sync SET walk_page = ?2, updated_at = ?3 WHERE app_id = ?1').bind(appId, page, now).run();
  }

  // The walk reached either the previous head (an incremental run) or the first commit of the branch.
  const sawEverything = !reachedPreviousHead;
  const rewrote = !full && sawEverything && previousHead !== null;
  if (full || rewrote) {
    // Everything this walk did not see is no longer on the default branch: keep the facts, drop them from aggregates.
    const gone = await db.prepare('UPDATE project_commits SET reachable = 0 WHERE github_repo_id = ?1 AND reachable = 1 AND (walk_id IS NULL OR walk_id <> ?2)').bind(repo.id, walkId).run();
    if (rewrote || (gone.meta?.changes ?? 0) > 0) {
      await db.prepare('UPDATE project_contribution_sync SET rewrite_detected_at = ?2 WHERE app_id = ?1').bind(appId, now).run();
      await event(db, appId, repo.id, 'history_reconciled', `${gone.meta?.changes ?? 0} commits no longer on ${repo.defaultBranch}`, now);
    }
  }
  const complete = full || rewrote || sync.backfill_complete === 1;
  await db.prepare(
    `UPDATE project_contribution_sync SET state = ?2, backfill_complete = ?3, head_sha = ?4, default_branch = ?5, walk_id = NULL, walk_head_sha = NULL, walk_page = 1, walk_full = 0,
       lease_until = NULL, last_error = NULL, error_count = 0, rate_limited_until = NULL, last_success_at = ?6, next_refresh_at = ?7, updated_at = ?6 WHERE app_id = ?1`,
  ).bind(appId, complete ? 'complete' : 'incomplete', complete ? 1 : 0, pinned ?? previousHead, repo.defaultBranch, now, now + REFRESH_MS).run();
  if (complete && sync.backfill_complete === 0) await event(db, appId, repo.id, 'backfill_complete', null, now);
  return 'complete';
}

async function pause(db: D1Database, appId: string, page: number, now: number, outcome: 'budget_exhausted'): Promise<IngestOutcome> {
  await db.prepare('UPDATE project_contribution_sync SET walk_page = ?2 WHERE app_id = ?1').bind(appId, page).run();
  await release(db, appId, 'incomplete', { nextRefreshAt: now + INCOMPLETE_RETRY_MS }, now);
  return outcome;
}

async function knownShas(db: D1Database, repoId: number, shas: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (shas.length === 0) return out;
  const { results } = await db.prepare(`SELECT sha, policy_version FROM project_commits WHERE github_repo_id = ?1 AND sha IN (${shas.map((_, i) => `?${i + 2}`).join(',')})`).bind(repoId, ...shas).all<{ sha: string; policy_version: number }>();
  for (const r of results ?? []) out.set(r.sha, r.policy_version);
  return out;
}

async function saveCommit(db: D1Database, appId: string, repoId: number, c: GhCommitSummary, walkId: string, now: number, t: { additions: number; deletions: number; filesCounted: number; filesExcluded: number }, counted: boolean, truncated: boolean) {
  await db.prepare(
    `INSERT INTO project_commits (github_repo_id, sha, app_id, author_github_id, author_login, author_kind, authored_at, parent_count, counted, additions, deletions, files_counted, files_excluded, co_authors, files_truncated, policy_version, reachable, walk_id, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, ?17, ?18)
     ON CONFLICT(github_repo_id, sha) DO UPDATE SET author_login = excluded.author_login, counted = excluded.counted, additions = excluded.additions, deletions = excluded.deletions,
       files_counted = excluded.files_counted, files_excluded = excluded.files_excluded, co_authors = excluded.co_authors, files_truncated = excluded.files_truncated,
       policy_version = excluded.policy_version, reachable = 1, walk_id = excluded.walk_id, ingested_at = excluded.ingested_at`,
  ).bind(repoId, c.sha, appId, c.authorId, c.authorLogin, c.authorType, c.authoredAt, c.parentCount, counted ? 1 : 0, t.additions, t.deletions, t.filesCounted, t.filesExcluded, countCoAuthors(c.message), truncated ? 1 : 0, POLICY_VERSION, walkId, now).run();
}

/** One scheduler tick: enrol nothing new, continue what is due. Bounded so a tick never fans out unboundedly. */
export async function refreshDueProjects(db: D1Database, gh: GitHubSource, now: number, limit = 3): Promise<Array<{ appId: string; outcome: IngestOutcome }>> {
  const { results } = await db.prepare(
    `SELECT s.app_id FROM project_contribution_sync s JOIN project_repositories r ON r.app_id = s.app_id
      WHERE s.next_refresh_at <= ?1 AND (s.lease_until IS NULL OR s.lease_until < ?1) AND r.status NOT IN ('identity_changed')
      ORDER BY s.next_refresh_at ASC, s.app_id ASC LIMIT ?2`,
  ).bind(now, limit).all<{ app_id: string }>();
  const out: Array<{ appId: string; outcome: IngestOutcome }> = [];
  for (const r of results ?? []) out.push({ appId: r.app_id, outcome: await refreshProject(db, gh, r.app_id, { now }) });
  return out;
}

/** Start tracking a few apps that have no record yet (newest first), so every app is picked up without any read writing. */
async function enrolProjects(db: D1Database, now: number, limit = 2): Promise<string[]> {
  const { results } = await db.prepare('SELECT a.id FROM apps a WHERE NOT EXISTS (SELECT 1 FROM project_contribution_sync s WHERE s.app_id = a.id) ORDER BY a.created_at DESC, a.id ASC LIMIT ?1').bind(limit).all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);
  for (const id of ids) await ensureProject(db, id, now);
  return ids;
}

/** The scheduled tick: enrol a few new apps, then continue whatever is due. Without a read token it does nothing and says so. */
export async function runContributionTick(db: D1Database, gh: GitHubSource | null, now: number): Promise<{ enrolled: string[]; refreshed: Array<{ appId: string; outcome: IngestOutcome }> } | 'unconfigured'> {
  if (!gh) return 'unconfigured';
  const enrolled = await enrolProjects(db, now);
  return { enrolled, refreshed: await refreshDueProjects(db, gh, now) };
}
