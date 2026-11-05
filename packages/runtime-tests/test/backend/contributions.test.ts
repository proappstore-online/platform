import { SELF, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { commit, FakeGitHub } from '../../../backend/src/lib/contributions/fake-github';
import { refreshProject, runContributionTick } from '../../../backend/src/lib/contributions/ingest';
import { BASE, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

// #545 to #547 on workerd and real D1: the ledger migration, the single-writer ingestion over a scripted history, and
// the authorized API. No GitHub is contacted: the history is a deterministic fake.

const env = providedEnv as unknown as Env;
const OWNER = 'gh:1', VIEWER = 'gh:2', STRANGER = 'gh:3';
const TABLES = ['project_contribution_events', 'project_contribution_sync', 'project_commits', 'project_repositories'];
const NOW = Date.now();

const as = async (uid: string, path: string, method = 'GET') => SELF.fetch(`${BASE}/v1${path}`, {
  method, headers: { Authorization: `Bearer ${await mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY)}` },
});
const get = async (path: string, uid = VIEWER) => { const r = await as(uid, path); return { status: r.status, body: await r.json<any>().catch(() => null) }; };
let gh: FakeGitHub;

beforeEach(async () => {
  mockNetwork();
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetTables();
  for (const uid of [OWNER, VIEWER, STRANGER, 'gh:501', 'gh:502']) await seedUser(uid);
  await seedApp('shop', OWNER);
  await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',1),('shop','gh:2','viewer',1)").run();
  gh = new FakeGitHub({ fullName: 'proappstore-online/shop' });
});

describe('project contributions on D1 (#544)', () => {
  it('reads a scripted history across pages and serves ranked, shared, bucketed figures', async () => {
    const day = Date.UTC(2026, 2, 10);
    gh.history = [
      commit({ authorId: 501, authorLogin: 'ada', adds: 60, dels: 4, authoredAt: day }),
      commit({ authorId: 502, authorLogin: 'bob', adds: 30, dels: 0, authoredAt: day }),
      commit({ authorId: 77, authorLogin: 'renovate[bot]', authorType: 'bot', adds: 10, dels: 10, authoredAt: day }),
      commit({ authorId: 501, authorLogin: 'ada', parentCount: 2, adds: 9999, authoredAt: day }),
      commit({ authorId: 501, authorLogin: 'ada', files: [{ filename: 'pnpm-lock.yaml', additions: 5000, deletions: 0, patch: '@@' }], authoredAt: day }),
    ];
    expect(await refreshProject(env.DB, gh, 'shop', { now: Date.now(), pageSize: 2 })).toBe('complete');

    const summary = await get('/apps/shop/contributions');
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ state: 'ok', complete: true, totals: { additions: 100, deletions: 14, commits: 3, people: 2 }, buckets: { bots: { additions: 10 } }, excluded: { merge_commits_not_counted: 1 } });

    const people = await get('/apps/shop/contributions/people?limit=1');
    expect(people.body.people).toHaveLength(1);
    expect(people.body.people[0]).toMatchObject({ rank: 1, github_account_id: 501, additions: 60, matched: true, share: { percent: 60 } });
    const next = await get(`/apps/shop/contributions/people?limit=1&cursor=${people.body.next.cursor}`);
    expect(next.body.people[0]).toMatchObject({ rank: 2, github_account_id: 502, additions: 30 });
    expect(next.body.next).toBeNull();

    const june = await get('/apps/shop/contributions?from=2026-04-01');
    expect(june.body).toMatchObject({ state: 'empty', totals: { additions: 0 } });
  });

  it('keeps the same commit once under repeated and concurrent reads', async () => {
    gh.history = Array.from({ length: 6 }, () => commit({ adds: 5 }));
    await Promise.all([refreshProject(env.DB, gh, 'shop', { now: NOW }), refreshProject(env.DB, gh, 'shop', { now: NOW }), refreshProject(env.DB, gh, 'shop', { now: NOW })]);
    await refreshProject(env.DB, gh, 'shop', { now: NOW + 1, force: true });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n, SUM(additions) AS a FROM project_commits').first<{ n: number; a: number }>())).toEqual({ n: 6, a: 30 });
  });

  it('is authorized: no session, a stranger and a different app are refused; refresh is owner-only', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/shop/contributions`)).status).toBe(401);
    expect((await get('/apps/shop/contributions', STRANGER)).status).toBe(403);
    expect((await get('/apps/nope/contributions', OWNER)).status).toBe(404);
    expect((await as(VIEWER, '/apps/shop/contributions/refresh', 'POST')).status).toBe(403);
  });

  it('reports unavailable before a first read, and a failed read never as zero', async () => {
    expect((await get('/apps/shop/contributions')).body).toMatchObject({ state: 'unavailable', complete: false });
    gh.failNext = [{ ok: false, kind: 'rate_limited', retryAt: NOW + 60_000 }];
    await refreshProject(env.DB, gh, 'shop', { now: NOW });
    expect((await get('/apps/shop/contributions')).body).toMatchObject({ state: 'error', complete: false, freshness: { rate_limited_until: NOW + 60_000 } });
  });

  it('reconciles a rewritten history on D1 and keeps the audit facts', async () => {
    const keep = commit({ adds: 5 }), lost = commit({ adds: 50 });
    gh.history = [lost, keep];
    await refreshProject(env.DB, gh, 'shop', { now: NOW });
    gh.history = [commit({ adds: 6 }), keep];
    await refreshProject(env.DB, gh, 'shop', { now: NOW + 1 });
    expect((await get('/apps/shop/contributions')).body).toMatchObject({ totals: { additions: 11 }, excluded: { unreachable_commits: 1 } });
    expect(await env.DB.prepare('SELECT reachable FROM project_commits WHERE sha = ?').bind(lost.sha).first()).toEqual({ reachable: 0 });
  });

  it('the scheduled tick enrols apps and does nothing, and says so, without a read token', async () => {
    expect(await runContributionTick(env.DB, null, NOW)).toBe('unconfigured');
    gh.history = [commit({ adds: 3 })];
    const out = await runContributionTick(env.DB, gh, NOW);
    expect(out).toMatchObject({ enrolled: ['shop'], refreshed: [{ appId: 'shop', outcome: 'complete' }] });
  });

  it('refuses to rewrite the append-only event log', async () => {
    gh.history = [commit()];
    await refreshProject(env.DB, gh, 'shop', { now: NOW });
    await expect(env.DB.prepare("UPDATE project_contribution_events SET detail = 'x'").run()).rejects.toThrow(/append-only/);
  });
});
