import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteD1 } from '../../sqlite-d1.js';
import { commit, FakeGitHub } from './fake-github.js';
import { ensureProject, projectRepository, refreshDueProjects, refreshProject, runContributionTick } from './ingest.js';

const T0 = 1_800_000_000_000;
let db: ReturnType<typeof sqliteD1>;
let gh: FakeGitHub;

const one = async <T>(sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(...p).first<T>())!;
const sync = () => one<Record<string, any>>('SELECT * FROM project_contribution_sync WHERE app_id = \'demo\'');
const live = () => one<{ n: number; a: number; d: number }>('SELECT COUNT(*) n, COALESCE(SUM(additions),0) a, COALESCE(SUM(deletions),0) d FROM project_commits WHERE reachable = 1 AND counted = 1');

beforeEach(async () => {
  db = sqliteD1();
  await db.prepare('INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES (\'gh:1\', \'github\', \'1\', \'owner\', 1, 1)').run();
  await db.prepare('INSERT INTO apps (id, creator_id, created_at) VALUES (\'demo\', \'gh:1\', 1)').run();
  gh = new FakeGitHub();
});

describe('repository binding', () => {
  it('derives the repository from the app and pins the transferred chess one', () => {
    expect(projectRepository('demo')).toEqual({ fullName: 'proappstore-online/demo', source: 'convention' });
    expect(projectRepository('chess-academy')).toEqual({ fullName: 'ChessClubs-online/chess-clubs', source: 'pinned' });
  });

  it('records the immutable repository id on first read and verifies it', async () => {
    gh.history = [commit()];
    expect(await refreshProject(db, gh, 'demo', { now: T0 })).toBe('complete');
    const r = await one<Record<string, any>>('SELECT * FROM project_repositories WHERE app_id = \'demo\'');
    expect(r).toMatchObject({ github_repo_id: 1001, status: 'verified', default_branch: 'main', full_name: 'proappstore-online/demo' });
  });

  it('stops as identity_changed when the same name resolves to a different repository, and never re-binds', async () => {
    gh.history = [commit()];
    await refreshProject(db, gh, 'demo', { now: T0 });
    gh.repo = { ...gh.repo, id: 9999 };
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 1, force: true })).toBe('identity_changed');
    expect(await one<any>('SELECT status, github_repo_id FROM project_repositories WHERE app_id = \'demo\'')).toMatchObject({ status: 'identity_changed', github_repo_id: 1001 });
    expect((await sync()).state).toBe('error');
    expect(gh.calls.listCommits).toBe(1); // nothing read from the impostor
  });

  it('a renamed repository with the same id keeps working', async () => {
    gh.history = [commit({ adds: 4 })];
    await refreshProject(db, gh, 'demo', { now: T0 });
    gh.repo = { ...gh.repo, fullName: 'proappstore-online/demo-renamed' };
    gh.history.unshift(commit({ adds: 6 }));
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 1 })).toBe('complete');
    expect((await live()).a).toBe(10);
  });
});

describe('backfill and incremental refresh', () => {
  it('reads every page, counts each commit once and marks the backfill complete', async () => {
    gh.history = Array.from({ length: 7 }, () => commit({ adds: 3, dels: 1 }));
    expect(await refreshProject(db, gh, 'demo', { now: T0, pageSize: 3 })).toBe('complete');
    expect(await live()).toEqual({ n: 7, a: 21, d: 7 });
    expect(await sync()).toMatchObject({ state: 'complete', backfill_complete: 1, head_sha: gh.history[0]!.sha, walk_id: null, lease_until: null });
  });

  it('is idempotent: a second full read changes nothing and fetches no commit details', async () => {
    gh.history = [commit(), commit(), commit()];
    await refreshProject(db, gh, 'demo', { now: T0 });
    const before = gh.calls.getCommitFiles;
    await refreshProject(db, gh, 'demo', { now: T0 + 1, force: true });
    expect(gh.calls.getCommitFiles).toBe(before);
    expect((await live()).n).toBe(3);
  });

  it('an incremental refresh reads only the new commits', async () => {
    gh.history = [commit({ adds: 5 }), commit({ adds: 5 })];
    await refreshProject(db, gh, 'demo', { now: T0 });
    gh.fileCalls = [];
    const fresh = commit({ adds: 7 });
    gh.history.unshift(fresh);
    await refreshProject(db, gh, 'demo', { now: T0 + 1 });
    expect(gh.fileCalls).toEqual([fresh.sha]);
    expect((await live()).a).toBe(17);
    expect((await sync()).head_sha).toBe(fresh.sha);
  });

  it('resumes an interrupted backfill from its checkpoint and never reports it complete early', async () => {
    gh.history = Array.from({ length: 9 }, () => commit({ adds: 2 }));
    expect(await refreshProject(db, gh, 'demo', { now: T0, pageSize: 3, budget: 4 })).toBe('budget_exhausted');
    let s = await sync();
    expect(s).toMatchObject({ state: 'incomplete', backfill_complete: 0, lease_until: null });
    expect(s.walk_id).not.toBeNull();
    // New pushes during the backfill must not shift the pinned pages.
    gh.history.unshift(commit({ adds: 100 }));
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 1, pageSize: 3, budget: 4 })).toBe('budget_exhausted');
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 2, pageSize: 3, budget: 4 })).toBe('complete');
    s = await sync();
    expect(s).toMatchObject({ state: 'complete', backfill_complete: 1 });
    expect((await live())).toEqual({ n: 9, a: 18, d: 0 }); // the 100-line push arrives on the next incremental run
    await refreshProject(db, gh, 'demo', { now: T0 + 3 });
    expect((await live()).a).toBe(118);
  });

  it('does not run while another worker holds the lease', async () => {
    gh.history = [commit()];
    await ensureProject(db, 'demo', T0);
    await db.prepare('UPDATE project_contribution_sync SET lease_until = ?1 WHERE app_id = \'demo\'').bind(T0 + 60_000).run();
    expect(await refreshProject(db, gh, 'demo', { now: T0 })).toBe('busy');
    expect(gh.calls.getRepo).toBe(0);
    // An expired lease is reclaimed.
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 120_000 })).toBe('complete');
  });

  it('two overlapping runs over the same history still count each commit once', async () => {
    gh.history = Array.from({ length: 5 }, () => commit({ adds: 4 }));
    const [a, b] = await Promise.all([refreshProject(db, gh, 'demo', { now: T0 }), refreshProject(db, gh, 'demo', { now: T0 })]);
    expect([a, b].sort()).toEqual(['busy', 'complete']);
    expect((await live()).a).toBe(20);
  });
});

describe('what is counted', () => {
  it('records a merge commit but adds nothing for it and fetches no files', async () => {
    const merged = commit({ adds: 9 });
    const merge = commit({ parentCount: 2, adds: 9999 });
    gh.history = [merge, merged];
    await refreshProject(db, gh, 'demo', { now: T0 });
    expect(gh.fileCalls).toEqual([merged.sha]);
    expect(await live()).toEqual({ n: 1, a: 9, d: 0 });
    expect(await one<any>('SELECT counted, parent_count FROM project_commits WHERE sha = ?1', merge.sha)).toEqual({ counted: 0, parent_count: 2 });
  });

  it('counts a squash once and a revert as its own removals, visibly', async () => {
    const add = commit({ adds: 20 });
    const revert = commit({ adds: 0, dels: 20, message: 'Revert "add"' });
    gh.history = [revert, add];
    await refreshProject(db, gh, 'demo', { now: T0 });
    expect(await live()).toEqual({ n: 2, a: 20, d: 20 });
  });

  it('applies the file policy: docs, lockfiles, generated and binaries are excluded', async () => {
    gh.history = [commit({ files: [
      { filename: 'src/a.ts', additions: 10, deletions: 1, patch: '@@' }, { filename: 'README.md', additions: 50, deletions: 0, patch: '@@' },
      { filename: 'pnpm-lock.yaml', additions: 900, deletions: 0, patch: '@@' }, { filename: 'dist/x.js', additions: 70, deletions: 0, patch: '@@' }, { filename: 'logo.png', additions: 0, deletions: 0 },
    ] })];
    await refreshProject(db, gh, 'demo', { now: T0 });
    expect(await one<any>('SELECT additions a, deletions d, files_counted c, files_excluded e FROM project_commits')).toEqual({ a: 10, d: 1, c: 1, e: 4 });
  });

  it('flags a commit whose file list GitHub truncated instead of claiming it is exact', async () => {
    gh.history = [commit({ truncated: true })];
    await refreshProject(db, gh, 'demo', { now: T0 });
    expect((await one<any>('SELECT files_truncated t FROM project_commits')).t).toBe(1);
  });

  it('keeps bots, unlinked authors and co-authors as recorded, never as merged identities', async () => {
    gh.history = [
      commit({ authorId: 77, authorLogin: 'dependabot[bot]', authorType: 'bot' }),
      commit({ authorId: null, authorLogin: null, authorType: 'unlinked' }),
      commit({ message: 'pair\n\nCo-authored-by: Bob <b@x.io>' }),
    ];
    await refreshProject(db, gh, 'demo', { now: T0 });
    const rows = (await db.prepare('SELECT author_kind k, author_github_id g, co_authors c FROM project_commits ORDER BY ingested_at, sha').all<any>()).results!;
    expect(rows.map((r) => r.k).sort()).toEqual(['bot', 'unlinked', 'user']);
    expect(rows.find((r) => r.k === 'user').c).toBe(1);
    expect(JSON.stringify(rows)).not.toContain('@');
  });

  it('keeps one author under a renamed login as one GitHub id', async () => {
    gh.history = [commit({ authorLogin: 'ada-new' }), commit({ authorLogin: 'ada-old' })];
    await refreshProject(db, gh, 'demo', { now: T0 });
    expect((await one<any>('SELECT COUNT(DISTINCT author_github_id) n FROM project_commits')).n).toBe(1);
  });
});

describe('failures never become zero or complete', () => {
  it('rate limited: records when to retry, stays incomplete, and a later run completes', async () => {
    gh.history = [commit(), commit()];
    gh.failNext = [{ ok: false, kind: 'rate_limited', retryAt: T0 + 600_000 }];
    expect(await refreshProject(db, gh, 'demo', { now: T0 })).toBe('rate_limited');
    expect(await sync()).toMatchObject({ state: 'incomplete', backfill_complete: 0, rate_limited_until: T0 + 600_000, next_refresh_at: T0 + 600_000, last_error: 'rate_limited' });
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 600_001 })).toBe('complete');
    expect((await sync()).rate_limited_until).toBeNull();
  });

  it('rate limited mid-walk keeps what was read and resumes', async () => {
    gh.history = Array.from({ length: 4 }, () => commit({ adds: 1 }));
    await ensureProject(db, 'demo', T0);
    gh.failNext = [];
    const real = gh.getCommitFiles.bind(gh);
    let n = 0;
    gh.getCommitFiles = async (...a) => (++n === 3 ? { ok: false, kind: 'rate_limited', retryAt: T0 + 5000 } : real(...a));
    expect(await refreshProject(db, gh, 'demo', { now: T0 })).toBe('rate_limited');
    expect((await live()).n).toBe(2);
    expect((await sync()).backfill_complete).toBe(0);
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 6000 })).toBe('complete');
    expect((await live()).n).toBe(4);
  });

  it('revoked access: access_lost, data kept, not complete, not zeroed', async () => {
    gh.history = [commit({ adds: 8 })];
    await refreshProject(db, gh, 'demo', { now: T0 });
    gh.failNext = [{ ok: false, kind: 'access_lost' }];
    expect(await refreshProject(db, gh, 'demo', { now: T0 + 1 })).toBe('access_lost');
    expect(await one<any>('SELECT status FROM project_repositories WHERE app_id = \'demo\'')).toEqual({ status: 'access_lost' });
    expect((await sync()).state).toBe('error');
    expect((await live()).a).toBe(8);
  });

  it('transient errors back off and count', async () => {
    gh.failNext = [{ ok: false, kind: 'transient', detail: 'github 502' }];
    expect(await refreshProject(db, gh, 'demo', { now: T0 })).toBe('transient_error');
    const s = await sync();
    expect(s).toMatchObject({ state: 'incomplete', backfill_complete: 0, error_count: 1 });
    expect(s.next_refresh_at).toBeGreaterThan(T0);
  });
});

describe('reconciliation', () => {
  it('a force-push marks commits no longer reachable, keeps them as audit facts, and excludes them from aggregates', async () => {
    const keep = commit({ adds: 5 });
    const lost = commit({ adds: 50 });
    gh.history = [lost, keep];
    await refreshProject(db, gh, 'demo', { now: T0 });
    const replacement = commit({ adds: 6 });
    gh.history = [replacement, keep];
    await refreshProject(db, gh, 'demo', { now: T0 + 1 });
    expect((await live()).a).toBe(11);
    expect(await one<any>('SELECT reachable r FROM project_commits WHERE sha = ?1', lost.sha)).toEqual({ r: 0 });
    expect((await sync()).rewrite_detected_at).not.toBeNull();
    expect((await one<any>('SELECT COUNT(*) n FROM project_contribution_events WHERE action = \'history_reconciled\'')).n).toBeGreaterThan(0);
  });

  it('a default-branch change triggers a full walk of the new branch', async () => {
    const a = commit({ adds: 5 });
    gh.history = [a];
    await refreshProject(db, gh, 'demo', { now: T0 });
    const b = commit({ adds: 9 });
    gh.history = [b];
    gh.repo = { ...gh.repo, defaultBranch: 'trunk' };
    await refreshProject(db, gh, 'demo', { now: T0 + 1 });
    expect((await live()).a).toBe(9);
    expect((await sync()).default_branch).toBe('trunk');
    expect((await one<any>('SELECT COUNT(*) n FROM project_contribution_events WHERE action = \'default_branch_changed\'')).n).toBe(1);
  });

  it('a policy version change recomputes stored commits', async () => {
    gh.history = [commit({ adds: 5 })];
    await refreshProject(db, gh, 'demo', { now: T0 });
    await db.prepare('UPDATE project_commits SET policy_version = 0, additions = 999').run();
    await db.prepare('UPDATE project_contribution_sync SET policy_version = 0').run();
    await refreshProject(db, gh, 'demo', { now: T0 + 1 });
    expect(await live()).toMatchObject({ a: 5 });
  });
});

describe('scheduler', () => {
  it('only continues due, unleased, non-conflicted projects, and at most `limit` per tick', async () => {
    gh.history = [commit()];
    await ensureProject(db, 'demo', T0);
    const out = await refreshDueProjects(db, gh, T0 + 1, 3);
    expect(out).toEqual([{ appId: 'demo', outcome: 'complete' }]);
    expect(await refreshDueProjects(db, gh, T0 + 2, 3)).toEqual([]); // not due again yet
  });

  it('skips a project whose repository identity changed', async () => {
    await ensureProject(db, 'demo', T0);
    await db.prepare('UPDATE project_repositories SET status = \'identity_changed\'').run();
    expect(await refreshDueProjects(db, gh, T0 + 1)).toEqual([]);
  });
});

describe('events are append-only', () => {
  it('cannot be rewritten', async () => {
    gh.history = [commit()];
    await refreshProject(db, gh, 'demo', { now: T0 });
    await expect(db.prepare('UPDATE project_contribution_events SET detail = \'x\'').run()).rejects.toThrow(/append-only/);
  });
});


describe('scheduled continuation (#556)', () => {
  it('continues a bounded pinned walk across ticks and later refreshes new commits', async () => {
    gh.history = Array.from({ length: 125 }, () => commit({ adds: 2 }));
    const head = gh.history[0]!.sha;
    expect(await runContributionTick(db, gh, T0)).toMatchObject({ enrolled: ['demo'], refreshed: [{ outcome: 'budget_exhausted' }] });
    expect(await sync()).toMatchObject({ backfill_complete: 0, walk_head_sha: head, walk_page: 1 });
    expect(gh.calls.getCommitFiles).toBe(40);
    expect(await runContributionTick(db, gh, T0 + 30_000)).toMatchObject({ refreshed: [] });
    gh.history.unshift(commit({ adds: 7 }));
    await runContributionTick(db, gh, T0 + 5 * 60_000);
    expect(await sync()).toMatchObject({ backfill_complete: 0, walk_head_sha: head });
    expect(gh.calls.getCommitFiles).toBe(80);
    expect(await runContributionTick(db, gh, T0 + 10 * 60_000)).toMatchObject({ refreshed: [{ outcome: 'budget_exhausted' }] });
    expect(await sync()).toMatchObject({ backfill_complete: 0, walk_head_sha: head, walk_page: 2 });
    expect(gh.calls.getCommitFiles).toBe(120);
    expect(await runContributionTick(db, gh, T0 + 15 * 60_000)).toMatchObject({ refreshed: [{ outcome: 'complete' }] });
    expect(await live()).toMatchObject({ n: 125, a: 250 });
    expect(await sync()).toMatchObject({ backfill_complete: 1, head_sha: head, walk_id: null });
    expect(await runContributionTick(db, gh, T0 + 20 * 60_000)).toMatchObject({ refreshed: [] });
    await runContributionTick(db, gh, T0 + 30 * 60_000);
    expect(await live()).toMatchObject({ n: 126, a: 257 });
    expect(gh.calls.getCommitFiles).toBe(126);
    expect(await sync()).toMatchObject({ head_sha: gh.history[0]!.sha, last_success_at: T0 + 30 * 60_000 });
  });
});
