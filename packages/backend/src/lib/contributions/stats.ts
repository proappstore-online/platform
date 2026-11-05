import { HttpError } from '../auth.js';
import { POLICY_DESCRIPTION, POLICY_VERSION } from './policy.js';

/**
 * Contribution read models (#547, epic #544). Computed at read time from the ledger, so a reconciliation, a policy
 * recompute or a correction changes totals, shares and rankings together.
 *
 * Meaning of the numbers:
 *  - Lines are the policy's COUNTED lines (see policy.ts) in non-merge commits reachable from the repository's current
 *    default branch, credited to the commit AUTHOR's GitHub account. Co-authors are counted, never credited.
 *  - A person's share is `their additions / ALL eligible additions in the period` (people, bots and unlinked authors
 *    together). Zero eligible additions gives a share of 0, never NaN.
 *  - People are ranked by additions, then by GitHub account id ascending, so the order is total and stable.
 *  - Bots and commits GitHub could not link to an account are separate buckets, never merged into a person.
 *  - A person is "matched" when their GitHub account id is a PAS user. That is a read-time join on the verified id; no
 *    identity is merged or inferred, and no PAS role, ownership or payout depends on it.
 *  - The period is half-open, `from <= author date < to`, in UTC.
 */

const REFRESH_MODE = 'scheduled';
const STALE_AFTER_MS = 3 * 15 * 60_000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const SHARE_BASIS = "This person's added lines divided by all eligible added lines (people, bots and unlinked authors) in the period.";

export type DataState = 'unavailable' | 'error' | 'partial' | 'stale' | 'empty' | 'ok';

interface Status {
  repository: { full_name: string; github_repo_id: number | null; status: string; default_branch: string | null; verified_at: number | null } | null;
  sync: { state: string; backfill_complete: boolean; head_sha: string | null; last_attempt_at: number | null; last_success_at: number | null; error: string | null; error_count: number; rate_limited_until: number | null; rewrite_detected_at: number | null; next_refresh_at: number; policy_version: number } | null;
}

interface RepoRow { full_name: string; github_repo_id: number | null; status: string; default_branch: string | null; verified_at: number | null }
interface SyncRow { state: string; backfill_complete: number; head_sha: string | null; last_attempt_at: number | null; last_success_at: number | null; last_error: string | null; error_count: number; rate_limited_until: number | null; rewrite_detected_at: number | null; next_refresh_at: number; policy_version: number }

async function status(db: D1Database, appId: string): Promise<Status> {
  const repo = await db.prepare('SELECT full_name, github_repo_id, status, default_branch, verified_at FROM project_repositories WHERE app_id = ?1').bind(appId).first<RepoRow>();
  const s = await db.prepare('SELECT state, backfill_complete, head_sha, last_attempt_at, last_success_at, last_error, error_count, rate_limited_until, rewrite_detected_at, next_refresh_at, policy_version FROM project_contribution_sync WHERE app_id = ?1').bind(appId).first<SyncRow>();
  return {
    repository: repo,
    sync: s && { state: s.state, backfill_complete: s.backfill_complete === 1, head_sha: s.head_sha, last_attempt_at: s.last_attempt_at, last_success_at: s.last_success_at, error: s.last_error ? s.last_error.split(':')[0]! : null, error_count: s.error_count, rate_limited_until: s.rate_limited_until, rewrite_detected_at: s.rewrite_detected_at, next_refresh_at: s.next_refresh_at, policy_version: s.policy_version },
  };
}

/** Distinct, never-false states. "No commits" is only ever `empty` once the whole history has been read. */
function dataState(st: Status, commitsInPeriod: number, now: number): { state: DataState; reason: string } {
  if (!st.repository || !st.sync || st.sync.last_attempt_at === null) return { state: 'unavailable', reason: 'The repository has not been read yet.' };
  if (st.repository.status === 'identity_changed') return { state: 'unavailable', reason: 'The repository name now points at a different repository; reading stopped.' };
  if (st.sync.last_success_at === null) {
    // No finished read yet: a run that is reading (or paused on its budget) is partial; only a recorded failure is an error.
    if (st.sync.error === 'rate_limited') return { state: 'error', reason: 'Nothing has been read yet: GitHub rate-limited the read. It is retried automatically.' };
    return st.sync.error ? { state: 'error', reason: `The repository could not be read (${st.sync.error}).` } : { state: 'partial', reason: 'History is still being read; totals are incomplete.' };
  }
  if (!st.sync.backfill_complete) return { state: 'partial', reason: 'History is still being read; totals are incomplete.' };
  if (st.repository.status === 'access_lost' || st.sync.error !== null || now - st.sync.last_success_at > STALE_AFTER_MS) {
    return { state: 'stale', reason: st.sync.error ? `The last refresh failed (${st.sync.error}); figures are from the last successful read.` : 'The last successful read is older than expected.' };
  }
  return commitsInPeriod === 0 ? { state: 'empty', reason: 'The full history was read and holds no eligible commits in this period.' } : { state: 'ok', reason: 'Complete and fresh.' };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function share(numerator: number, denominator: number) {
  const ratio = denominator === 0 ? 0 : numerator / denominator;
  return { numerator, denominator, ratio: Math.round(ratio * 1e6) / 1e6, percent: Math.round(ratio * 1e4) / 1e2 };
}

export interface Period { from: number | null; to: number | null }
// A commit whose every file the policy excluded (docs, lockfiles, generated) has nothing eligible and is not an eligible commit.
const IN_PERIOD = '(?3 IS NULL OR c.authored_at >= ?3) AND (?4 IS NULL OR c.authored_at < ?4)';
const periodView = (p: Period) => ({ from: p.from, to: p.to, from_iso: iso(p.from), to_iso: iso(p.to), rule: 'from <= commit author date (UTC) < to' });

function freshness(st: Status, now: number) {
  return {
    refresh_mode: REFRESH_MODE,
    last_success_at: st.sync?.last_success_at ?? null, last_success_iso: iso(st.sync?.last_success_at ?? null),
    last_attempt_at: st.sync?.last_attempt_at ?? null,
    next_refresh_at: st.sync ? Math.max(st.sync.next_refresh_at, 0) : null,
    age_ms: st.sync?.last_success_at ? now - st.sync.last_success_at : null,
    rate_limited_until: st.sync?.rate_limited_until ?? null,
    backfill_complete: st.sync?.backfill_complete ?? false,
    head_sha: st.sync?.head_sha ?? null,
    rewrite_detected_at: st.sync?.rewrite_detected_at ?? null,
    note: 'There is no push webhook for platform-provisioned repositories: the platform re-reads each repository on a schedule, so figures can lag a push by the refresh interval. An owner can request a refresh.',
  };
}

interface KindRow { author_kind: string; commits: number; additions: number; deletions: number; truncated: number; co_authored: number }

async function totals(db: D1Database, appId: string, repoId: number, period: Period) {
  const { results } = await db.prepare(
    `SELECT c.author_kind, COUNT(*) AS commits, COALESCE(SUM(c.additions), 0) AS additions, COALESCE(SUM(c.deletions), 0) AS deletions,
            COALESCE(SUM(c.files_truncated), 0) AS truncated, COALESCE(SUM(CASE WHEN c.co_authors > 0 THEN 1 ELSE 0 END), 0) AS co_authored
       FROM project_commits c WHERE c.app_id = ?1 AND c.github_repo_id = ?2 AND c.reachable = 1 AND c.counted = 1 AND c.files_counted > 0 AND ${IN_PERIOD} GROUP BY c.author_kind`,
  ).bind(appId, repoId, period.from, period.to).all<KindRow>();
  const by = (k: string) => (results ?? []).find((r) => r.author_kind === k);
  const n = (r: KindRow | undefined) => ({ commits: Number(r?.commits ?? 0), additions: Number(r?.additions ?? 0), deletions: Number(r?.deletions ?? 0) });
  const people = n(by('user')), bots = n(by('bot')), unlinked = n(by('unlinked'));
  const all = [...(results ?? [])];
  return {
    people, bots, unlinked,
    additions: people.additions + bots.additions + unlinked.additions,
    deletions: people.deletions + bots.deletions + unlinked.deletions,
    commits: people.commits + bots.commits + unlinked.commits,
    truncated_commits: all.reduce((a, r) => a + Number(r.truncated), 0),
    co_authored_commits: all.reduce((a, r) => a + Number(r.co_authored), 0),
  };
}

async function skipped(db: D1Database, appId: string, repoId: number, period: Period) {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN c.reachable = 0 THEN 1 ELSE 0 END), 0) AS unreachable, COALESCE(SUM(CASE WHEN c.reachable = 1 AND c.counted = 0 THEN 1 ELSE 0 END), 0) AS merges
       FROM project_commits c WHERE c.app_id = ?1 AND c.github_repo_id = ?2 AND ${IN_PERIOD}`,
  ).bind(appId, repoId, period.from, period.to).first<{ unreachable: number; merges: number }>();
  return { unreachable_commits: Number(row?.unreachable ?? 0), merge_commits_not_counted: Number(row?.merges ?? 0) };
}

/** Project summary: state, freshness, policy, totals, buckets. No per-person rows (see `people`). */
export async function projectSummary(db: D1Database, appId: string, period: Period, now: number) {
  const st = await status(db, appId);
  const repoId = st.repository?.github_repo_id ?? null;
  const empty = { people: { commits: 0, additions: 0, deletions: 0 }, bots: { commits: 0, additions: 0, deletions: 0 }, unlinked: { commits: 0, additions: 0, deletions: 0 }, additions: 0, deletions: 0, commits: 0, truncated_commits: 0, co_authored_commits: 0 };
  const t = repoId === null ? empty : await totals(db, appId, repoId, period);
  const excluded = repoId === null ? { unreachable_commits: 0, merge_commits_not_counted: 0 } : await skipped(db, appId, repoId, period);
  const people = repoId === null ? 0 : Number((await db.prepare(`SELECT COUNT(DISTINCT c.author_github_id) AS n FROM project_commits c WHERE c.app_id = ?1 AND c.github_repo_id = ?2 AND c.reachable = 1 AND c.counted = 1 AND c.files_counted > 0 AND c.author_kind = 'user' AND ${IN_PERIOD}`).bind(appId, repoId, period.from, period.to).first<{ n: number }>())?.n ?? 0);
  const verdict = dataState(st, t.commits, now);
  return {
    app_id: appId,
    state: verdict.state, state_reason: verdict.reason,
    // Only a fully read history may be called complete; `ok` and `empty` are the only states that say "this is the answer".
    complete: st.sync?.backfill_complete === true,
    repository: st.repository && { full_name: st.repository.full_name, status: st.repository.status, default_branch: st.repository.default_branch, verified_at: st.repository.verified_at },
    period: periodView(period),
    policy: POLICY_DESCRIPTION,
    policy_version: POLICY_VERSION,
    freshness: freshness(st, now),
    totals: { additions: t.additions, deletions: t.deletions, commits: t.commits, people: people, truncated_commits: t.truncated_commits, co_authored_commits: t.co_authored_commits },
    buckets: { bots: t.bots, unlinked: t.unlinked },
    excluded,
    share_basis: SHARE_BASIS,
  };
}

export interface PeopleQuery { limit: number; cursor: Cursor | null }
export interface Cursor { rank: number; additions: number; id: number }

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new HttpError('limit must be a positive integer', 400);
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) throw new HttpError(`limit must be between 1 and ${MAX_LIMIT}`, 400);
  return n;
}

export function parseCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined || raw === '') return null;
  const m = /^(\d{1,7})\.(\d{1,15})\.(\d{1,15})$/.exec(raw);
  if (!m) throw new HttpError('cursor is not valid', 400);
  return { rank: Number(m[1]), additions: Number(m[2]), id: Number(m[3]) };
}
const encodeCursor = (c: Cursor) => `${c.rank}.${c.additions}.${c.id}`;

interface PersonRow { id: number; additions: number; deletions: number; commits: number; last_commit_at: number; github_login: string | null; user_id: string | null }

/** One page of people, ranked by additions then GitHub account id. Unmatched accounts are included and flagged. */
export async function projectPeople(db: D1Database, appId: string, period: Period, q: PeopleQuery, now: number) {
  const st = await status(db, appId);
  const repoId = st.repository?.github_repo_id ?? null;
  const verdict = dataState(st, 0, now);
  const base = { app_id: appId, period: periodView(period), policy_version: POLICY_VERSION, share_basis: SHARE_BASIS, tie_order: 'additions descending, then GitHub account id ascending' };
  if (repoId === null) return { ...base, state: verdict.state, state_reason: verdict.reason, complete: false, freshness: freshness(st, now), eligible_additions: 0, people: [], next: null };

  const t = await totals(db, appId, repoId, period);
  const state = dataState(st, t.commits, now);
  const { results } = await db.prepare(
    `SELECT c.author_github_id AS id, SUM(c.additions) AS additions, SUM(c.deletions) AS deletions, COUNT(*) AS commits, MAX(c.authored_at) AS last_commit_at,
            (SELECT p.author_login FROM project_commits p WHERE p.github_repo_id = c.github_repo_id AND p.author_github_id = c.author_github_id AND p.author_login IS NOT NULL ORDER BY p.authored_at DESC, p.sha ASC LIMIT 1) AS github_login,
            u.id AS user_id
       FROM project_commits c LEFT JOIN users u ON u.id = 'gh:' || c.author_github_id AND u.provider = 'github'
      WHERE c.app_id = ?1 AND c.github_repo_id = ?2 AND c.reachable = 1 AND c.counted = 1 AND c.files_counted > 0 AND c.author_kind = 'user' AND ${IN_PERIOD}
      GROUP BY c.author_github_id
     HAVING ?5 IS NULL OR SUM(c.additions) < ?5 OR (SUM(c.additions) = ?5 AND c.author_github_id > ?6)
      ORDER BY SUM(c.additions) DESC, c.author_github_id ASC LIMIT ?7`,
  ).bind(appId, repoId, period.from, period.to, q.cursor?.additions ?? null, q.cursor?.id ?? null, q.limit + 1).all<PersonRow>();
  const rows = results ?? [];
  const page = rows.slice(0, q.limit);
  const startRank = q.cursor?.rank ?? 0;
  const people = page.map((r, i) => ({
    rank: startRank + i + 1,
    github_account_id: Number(r.id),
    github_login: r.github_login,
    matched: r.user_id !== null,
    user_id: r.user_id,
    additions: Number(r.additions), deletions: Number(r.deletions), commits: Number(r.commits),
    last_commit_at: Number(r.last_commit_at), last_commit_iso: iso(Number(r.last_commit_at)),
    share: { ...share(Number(r.additions), t.additions), basis: SHARE_BASIS },
  }));
  const last = people[people.length - 1];
  return {
    ...base,
    state: state.state, state_reason: state.reason,
    complete: st.sync?.backfill_complete === true,
    freshness: freshness(st, now),
    eligible_additions: t.additions,
    people,
    next: rows.length > q.limit && last ? { cursor: encodeCursor({ rank: last.rank, additions: last.additions, id: last.github_account_id }) } : null,
  };
}
