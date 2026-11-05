import { beforeEach, describe, expect, it } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { commit, FakeGitHub } from '../lib/contributions/fake-github.js';
import { refreshProject } from '../lib/contributions/ingest.js';

// #547 on real SQL (every migration applied): the authorized project contribution API over the #545 ledger.

let db: ReturnType<typeof sqliteD1>;
let env: Env;
let gh: FakeGitHub;
const OWNER = 'gh:1', VIEWER = 'gh:2', STRANGER = 'gh:3';
const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const NOW = Date.now();

const call = async (method: string, path: string, uid: string | null, e: Env = env) =>
  app.request(`/v1${path}`, {
    method,
    headers: uid ? { Authorization: `Bearer ${await mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', cred: credentialContext('first_party_session') }, e.SESSION_SIGNING_KEY)}` } : {},
  }, e);
const get = async (path: string, uid: string | null = VIEWER) => { const r = await call('GET', path, uid); return { r, status: r.status, body: (await r.clone().json().catch(() => null)) as any }; };
const read = (over: Partial<{ now: number; pageSize: number; budget: number }> = {}) => refreshProject(db, gh, 'shop', { now: NOW, ...over });

beforeEach(async () => {
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
      ('gh:1','github','1','owner',0,0),('gh:2','github','2','viewer',0,0),('gh:3','github','3','stranger',0,0),('gh:501','github','501','ada',0,0),('gh:502','github','502','bob',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('shop','gh:1',1),('quiet','gh:1',2);
    INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',0),('shop','gh:2','viewer',0),('quiet','gh:1','owner',0);
    INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('quiet','private','[]',0);`);
  env = makeEnv({ DB: db }) as Env;
  gh = new FakeGitHub({ fullName: 'proappstore-online/shop' });
});

describe('authorization', () => {
  it('needs a session', async () => {
    for (const p of ['/apps/shop/contributions', '/apps/shop/contributions/people', '/apps/shop/contributions/policy']) expect((await get(p, null)).status).toBe(401);
  });

  it('a stranger is refused, even for a public app, and gets no figures', async () => {
    for (const p of ['/apps/shop/contributions', '/apps/shop/contributions/people']) expect((await get(p, STRANGER)).status).toBe(403);
  });

  it('a team viewer and the owner can read; an unknown app is 404', async () => {
    expect((await get('/apps/shop/contributions', VIEWER)).status).toBe(200);
    expect((await get('/apps/shop/contributions', OWNER)).status).toBe(200);
    expect((await get('/apps/nope/contributions', OWNER)).status).toBe(404);
  });

  it('reads are never cacheable', async () => {
    expect((await get('/apps/shop/contributions')).r.headers.get('cache-control')).toBe('private, no-store');
  });

  it('refresh is owner-only and needs a configured read token', async () => {
    expect((await call('POST', '/apps/shop/contributions/refresh', VIEWER)).status).toBe(403);
    expect((await call('POST', '/apps/shop/contributions/refresh', STRANGER)).status).toBe(403);
    expect((await call('POST', '/apps/shop/contributions/refresh', null)).status).toBe(401);
    expect((await call('POST', '/apps/shop/contributions/refresh', OWNER)).status).toBe(503); // no GITHUB_TOKEN here
  });

  it('exposes no way to name a repository', async () => {
    gh.history = [commit()];
    await read();
    const { body } = await get('/apps/shop/contributions?repo=evil/other&repository=evil/other&github_repo_id=7');
    expect(body.repository.full_name).toBe('proappstore-online/shop');
  });
});

describe('distinct states, never a false zero', () => {
  it('unavailable before the first read', async () => {
    const { body } = await get('/apps/shop/contributions');
    expect(body).toMatchObject({ state: 'unavailable', complete: false, totals: { additions: 0, commits: 0 } });
    expect(body.state_reason).toMatch(/not been read/);
    expect((await get('/apps/shop/contributions/people')).body).toMatchObject({ state: 'unavailable', people: [], next: null });
  });

  it('partial while the backfill is incomplete, with what is known so far', async () => {
    gh.history = Array.from({ length: 6 }, () => commit({ adds: 2 }));
    await read({ pageSize: 2, budget: 3 });
    const { body } = await get('/apps/shop/contributions');
    expect(body).toMatchObject({ state: 'partial', complete: false });
    expect(body.totals.additions).toBe(6);
  });

  it('ok when complete and fresh', async () => {
    gh.history = [commit({ adds: 4 })];
    await read({ now: Date.now() });
    expect((await get('/apps/shop/contributions')).body).toMatchObject({ state: 'ok', complete: true });
  });

  it('empty only after the whole history was read and holds nothing eligible', async () => {
    gh.history = [commit({ files: [{ filename: 'README.md', additions: 5, deletions: 0, patch: '@@' }] })];
    await read({ now: Date.now() });
    expect((await get('/apps/shop/contributions')).body).toMatchObject({ state: 'empty', complete: true, totals: { additions: 0 } });
  });

  it('stale when the last good read is old, and when the last refresh failed, keeping the figures', async () => {
    gh.history = [commit({ adds: 4 })];
    await read({ now: Date.now() - 3 * 3_600_000 });
    expect((await get('/apps/shop/contributions')).body).toMatchObject({ state: 'stale', complete: true, totals: { additions: 4 } });
    await read({ now: Date.now() });
    expect((await get('/apps/shop/contributions')).body.state).toBe('ok');
    gh.failNext = [{ ok: false, kind: 'access_lost' }];
    await db.prepare('UPDATE project_contribution_sync SET lease_until = NULL').run();
    await read({ now: Date.now() + 1, });
    const { body } = await get('/apps/shop/contributions');
    expect(body).toMatchObject({ state: 'stale', totals: { additions: 4 } });
    expect(body.state_reason).toMatch(/access_lost/);
  });

  it('error when nothing has ever been read successfully', async () => {
    gh.failNext = [{ ok: false, kind: 'access_lost' }];
    await read();
    expect((await get('/apps/shop/contributions')).body).toMatchObject({ state: 'error', complete: false });
  });

  it('unavailable when the repository identity changed', async () => {
    gh.history = [commit()];
    await read();
    gh.repo = { ...gh.repo, id: 4242 };
    await read({ now: NOW + 1 });
    expect((await get('/apps/shop/contributions')).body.state).toBe('unavailable');
  });

  it('reports a rate limit without an error message from GitHub', async () => {
    gh.failNext = [{ ok: false, kind: 'rate_limited', retryAt: NOW + 60_000 }];
    await read();
    const { body } = await get('/apps/shop/contributions');
    expect(body.freshness.rate_limited_until).toBe(NOW + 60_000);
    expect(body.freshness).toMatchObject({ backfill_complete: false, refresh_mode: 'scheduled' });
  });
});

describe('totals, people and shares', () => {
  beforeEach(async () => {
    gh.history = [
      commit({ authorId: 501, authorLogin: 'ada', adds: 60, dels: 5, authoredAt: D('2026-03-15') }),
      commit({ authorId: 501, authorLogin: 'ada', adds: 20, dels: 0, authoredAt: D('2026-02-10') }),
      commit({ authorId: 502, authorLogin: 'bob', adds: 10, dels: 1, authoredAt: D('2026-03-01') }),
      commit({ authorId: 900, authorLogin: 'stranger-dev', adds: 5, dels: 0, authoredAt: D('2026-03-02') }), // not a PAS user
      commit({ authorId: 77, authorLogin: 'dependabot[bot]', authorType: 'bot', adds: 3, dels: 3, authoredAt: D('2026-03-03') }),
      commit({ authorId: null, authorLogin: null, authorType: 'unlinked', adds: 2, dels: 0, authoredAt: D('2026-03-04') }),
      commit({ authorId: 501, authorLogin: 'ada', parentCount: 2, adds: 5000, authoredAt: D('2026-03-05') }), // merge
    ];
    await read({ now: Date.now() });
  });

  it('summarises totals with separate bot and unlinked buckets and excludes merges', async () => {
    const { body } = await get('/apps/shop/contributions');
    expect(body.totals).toMatchObject({ additions: 100, deletions: 9, commits: 6, people: 3 });
    expect(body.buckets).toEqual({ bots: { commits: 1, additions: 3, deletions: 3 }, unlinked: { commits: 1, additions: 2, deletions: 0 } });
    expect(body.excluded).toMatchObject({ merge_commits_not_counted: 1, unreachable_commits: 0 });
    expect(body.policy).toMatchObject({ version: 1 });
    expect(body.policy_version).toBe(1);
  });

  it('ranks people by additions, shares add up over all eligible lines, and flags unmatched accounts', async () => {
    const { body } = await get('/apps/shop/contributions/people');
    expect(body.eligible_additions).toBe(100);
    expect(body.people.map((p: any) => [p.rank, p.github_login, p.additions, p.matched])).toEqual([[1, 'ada', 80, true], [2, 'bob', 10, true], [3, 'stranger-dev', 5, false]]);
    expect(body.people[0].share).toMatchObject({ numerator: 80, denominator: 100, ratio: 0.8, percent: 80 });
    expect(body.people[0]).toMatchObject({ deletions: 5, commits: 2, user_id: 'gh:501' });
    expect(body.people[2].user_id).toBeNull();
    const pct = body.people.reduce((a: number, p: any) => a + p.share.percent, 0);
    expect(pct + 5).toBe(100); // the rest is the 3 bot + 2 unlinked lines: 5%
  });

  it('applies explicit UTC bounds: from inclusive, to exclusive', async () => {
    const day = async (q: string) => (await get(`/apps/shop/contributions/people?${q}`)).body;
    expect((await day('from=2026-03-01&to=2026-03-02')).people.map((p: any) => p.github_login)).toEqual(['bob']);
    expect((await day('from=2026-03-01&to=2026-03-03')).people.map((p: any) => p.github_login)).toEqual(['bob', 'stranger-dev']);
    expect((await day('to=2026-03-01')).people.map((p: any) => [p.github_login, p.additions])).toEqual([['ada', 20]]);
    const t = (await get('/apps/shop/contributions?from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z')).body;
    expect(t.period).toMatchObject({ from: D('2026-03-01'), to: D('2026-03-02'), from_iso: '2026-03-01T00:00:00.000Z' });
    expect(t.totals.additions).toBe(10);
  });

  it('a period with no commits is a zero share, not NaN, and the state says why', async () => {
    const { body } = await get('/apps/shop/contributions/people?from=2030-01-01');
    expect(body).toMatchObject({ state: 'empty', eligible_additions: 0, people: [], next: null });
  });

  it('paginates with a stable cursor and deterministic tie order', async () => {
    const first = (await get('/apps/shop/contributions/people?limit=2')).body;
    expect(first.people.map((p: any) => p.github_login)).toEqual(['ada', 'bob']);
    expect(first.next.cursor).toMatch(/^\d+\.\d+\.\d+$/);
    const second = (await get(`/apps/shop/contributions/people?limit=2&cursor=${first.next.cursor}`)).body;
    expect(second.people.map((p: any) => [p.rank, p.github_login])).toEqual([[3, 'stranger-dev']]);
    expect(second.next).toBeNull();
  });

  it('breaks an additions tie by GitHub account id ascending, across pages', async () => {
    gh.history = [
      commit({ authorId: 603, authorLogin: 'c', adds: 7 }), commit({ authorId: 601, authorLogin: 'a', adds: 7 }), commit({ authorId: 602, authorLogin: 'b', adds: 7 }),
    ];
    await db.prepare('DELETE FROM project_commits').run();
    await db.prepare('UPDATE project_contribution_sync SET backfill_complete = 0, head_sha = NULL, next_refresh_at = 0').run();
    await read({ now: Date.now() + 5 });
    const a = (await get('/apps/shop/contributions/people?limit=2')).body;
    const b = (await get(`/apps/shop/contributions/people?limit=2&cursor=${a.next.cursor}`)).body;
    expect([...a.people, ...b.people].map((p: any) => [p.rank, p.github_account_id])).toEqual([[1, 601], [2, 602], [3, 603]]);
  });

  it('refuses bad parameters', async () => {
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'cursor=bogus', 'from=yesterday', 'from=2026-03-02&to=2026-03-01']) {
      expect([q, (await get(`/apps/shop/contributions/people?${q}`)).status]).toEqual([q, 400]);
    }
  });

  it('exposes safe fields only: no email, token, commit message or raw author data', async () => {
    const text = JSON.stringify([(await get('/apps/shop/contributions')).body, (await get('/apps/shop/contributions/people')).body]);
    expect(text).not.toMatch(/@|email|token|"message"|"sha"|author_email/i);
  });

  it('serves the policy, with documentation excluded and tests counted', async () => {
    const { body } = await get('/apps/shop/contributions/policy');
    expect(body.policy).toMatchObject({ version: 1, tests: 'counted' });
    expect(body.policy.documentation).toMatch(/not counted/);
  });
});

describe('private apps stay private', () => {
  it('a private app answers only its own team', async () => {
    expect((await get('/apps/quiet/contributions', OWNER)).status).toBe(200);
    expect((await get('/apps/quiet/contributions', VIEWER)).status).toBe(403);
    expect((await get('/apps/quiet/contributions', null)).status).toBe(401);
  });
});
