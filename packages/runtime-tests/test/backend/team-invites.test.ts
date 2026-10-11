import { createExecutionContext, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../../backend/src/index';
import type { Env } from '../../../backend/src/types';
import { BASE, json, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #362 (#303 L5) on real D1: a team invite is consumed by one DELETE … RETURNING
// before any role is granted, so concurrent accepts of one invite have one winner.
// The handler runs in-process on the real D1 binding, so parallel accepts interleave
// at every await the way concurrent requests do.

const accept = async (token: string, uid: string) =>
  worker.fetch(new Request(`${BASE}/v1/team/accept/${token}`, json('POST', undefined, await session(uid))), env, createExecutionContext());
const invite = (token: string, role: string, expiresAt = Date.now() + 86_400_000) =>
  env.DB.prepare("INSERT INTO team_invites (id, app_id, role, invited_by, email, token, expires_at, created_at) VALUES (?, 'teamapp', ?, 'gh:owner', NULL, ?, ?, ?)")
    .bind(`inv-${token}`, role, token, expiresAt, Date.now()).run();
const members = async () => (await env.DB.prepare("SELECT user_id, role FROM team_members WHERE app_id = 'teamapp' ORDER BY user_id").all<{ user_id: string; role: string }>()).results ?? [];
const invitesLeft = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM team_invites WHERE app_id = 'teamapp'").first<{ n: number }>())!.n;

beforeEach(async () => {
  await resetTables();
  for (const t of ['team_invites', 'team_members']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const uid of ['gh:owner', 'gh:a', 'gh:b', 'gh:c']) await seedUser(uid);
  await seedApp('teamapp', 'gh:owner');
});

describe('team invite acceptance (#362)', () => {
  it('three users racing one admin invite: exactly one joins, the others get 404', async () => {
    await invite('race', 'admin');
    const res = await Promise.all(['gh:a', 'gh:b', 'gh:c'].map((uid) => accept('race', uid)));
    expect(res.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    const joined = await members();
    expect(joined).toHaveLength(1);
    expect(joined[0]!.role).toBe('admin');
    expect(await invitesLeft()).toBe(0);
  });

  it('an expired invite is consumed with 410 and grants nothing', async () => {
    await invite('old', 'admin', Date.now() - 1000);
    expect((await accept('old', 'gh:a')).status).toBe(410);
    expect(await members()).toEqual([]);
    expect(await invitesLeft()).toBe(0);
    expect((await accept('old', 'gh:a')).status).toBe(404);
  });

  it('a higher existing role is never downgraded, and the invite is still consumed', async () => {
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, invited_by, created_at) VALUES ('teamapp', 'gh:a', 'admin', 'gh:owner', ?)").bind(Date.now()).run();
    await invite('lower', 'viewer');
    expect((await accept('lower', 'gh:a')).status).toBe(200);
    expect(await members()).toEqual([{ user_id: 'gh:a', role: 'admin' }]);
    expect(await invitesLeft()).toBe(0);
  });
});
