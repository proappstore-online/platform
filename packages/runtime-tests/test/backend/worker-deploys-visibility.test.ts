import { SELF, env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = testEnv as unknown as Env;

// #261 on real D1: the two reads the console's Server tab needs — the worker's
// deploy history on GET /v1/apps/:id/worker, and the app's declared visibility
// (mode + allowed roles) on GET /v1/apps/:id/visibility. Owner (or platform
// admin) only; nothing secret.

const T0 = 1_790_000_000_000;
const get = async (path: string, uid?: string, roles?: string[]) =>
  SELF.fetch(`${BASE}${path}`, json('GET', undefined, uid ? await session(uid, roles ? { roles } : {}) : undefined));

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_worker_deploys', 'app_workers', 'app_visibility', 'team_members']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const uid of ['gh:owner', 'gh:other', 'gh:admin', 'gh:teamviewer']) await seedUser(uid);
  await seedApp('w-app', 'gh:owner');
  await seedApp('their-app', 'gh:other');
  // 25 deploys, oldest first: d00 … d24.
  for (let i = 0; i < 25; i++) {
    await env.DB.prepare(
      `INSERT INTO app_worker_deploys (id, app_id, repository, ref, sha, bundle_sha256, status, detail, created_at)
       VALUES (?, 'w-app', 'proappstore-online/w-app', 'refs/heads/main', ?, ?, ?, ?, ?)`,
    ).bind(`d${String(i).padStart(2, '0')}`, `sha${i}`, `bundle${i}`, i % 5 === 0 ? 'refused' : 'deployed', i % 5 === 0 ? 'app workers are not enabled for this app' : 'redeploy', T0 + i * 1000).run();
  }
  await env.DB.prepare("INSERT INTO app_worker_deploys (id, app_id, repository, ref, sha, bundle_sha256, status, detail, created_at) VALUES ('x1', 'their-app', 'proappstore-online/their-app', 'refs/heads/main', 's', 'b', 'deployed', 'redeploy', ?)").bind(T0 + 99_000).run();
  // A worker row carrying credentials the history must never expose.
  await env.DB.prepare("INSERT INTO app_workers (app_id, enabled, token_hash, deployed_sha, deployed_at) VALUES ('w-app', 1, 'secret-token-hash', 'sha24', ?)").bind(T0).run();
});

describe('GET /v1/apps/:appId/worker — deploy history (#261)', () => {
  it('the owner gets the last 20 deploys, newest first, beside an unchanged last_deploy', async () => {
    const res = await get('/v1/apps/w-app/worker', 'gh:owner');
    expect(res.status).toBe(200);
    const body = await res.json() as { last_deploy: Record<string, unknown>; deploys: Record<string, unknown>[] };
    expect(body.deploys).toHaveLength(20);
    expect(body.deploys.map((d) => d.id)).toEqual(Array.from({ length: 20 }, (_, k) => `d${String(24 - k).padStart(2, '0')}`));
    expect(body.deploys[0]).toEqual({
      id: 'd24', repository: 'proappstore-online/w-app', ref: 'refs/heads/main', sha: 'sha24', bundle_sha256: 'bundle24',
      status: 'deployed', detail: 'redeploy', created_at: T0 + 24_000,
    });
    expect(body.deploys.find((d) => d.id === 'd20')).toMatchObject({ status: 'refused', detail: 'app workers are not enabled for this app' });
    // last_deploy keeps its original shape.
    expect(body.last_deploy).toEqual({
      repository: 'proappstore-online/w-app', ref: 'refs/heads/main', sha: 'sha24', bundle_sha256: 'bundle24',
      status: 'deployed', detail: 'redeploy', created_at: T0 + 24_000,
    });
    // Only this app's deploys, and no credential anywhere in the answer.
    expect(body.deploys.some((d) => d.id === 'x1')).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('secret-token-hash');
    expect(raw).not.toMatch(/token|event_key|sealed/i);
  });

  it('an app with no deploys answers an empty history', async () => {
    await env.DB.prepare("DELETE FROM app_worker_deploys WHERE app_id = 'w-app'").run();
    const body = await (await get('/v1/apps/w-app/worker', 'gh:owner')).json() as { last_deploy: unknown; deploys: unknown[] };
    expect(body).toMatchObject({ last_deploy: null, deploys: [] });
  });

  it('another app\'s owner is refused, and so is a signed-out caller', async () => {
    expect((await get('/v1/apps/w-app/worker', 'gh:other')).status).toBe(403);
    expect((await get('/v1/apps/w-app/worker')).status).toBe(401);
  });
});

describe('GET /v1/apps/:appId/visibility (#261)', () => {
  it('the owner reads the declared mode and allowed roles', async () => {
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('w-app', 'private', '[\"moderator\",\"editor\"]', 1)").run();
    const res = await get('/v1/apps/w-app/visibility', 'gh:owner');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ mode: 'private', allowed_roles: ['moderator', 'editor'] });
  });

  it('an app that declares none is public with no roles; a platform admin may read it too', async () => {
    expect(await (await get('/v1/apps/w-app/visibility', 'gh:owner')).json()).toEqual({ mode: 'public', allowed_roles: [] });
    const asAdmin = await get('/v1/apps/w-app/visibility', 'gh:admin', ['user', 'admin']);
    expect(asAdmin.status).toBe(200);
    expect(await asAdmin.json()).toEqual({ mode: 'public', allowed_roles: [] });
  });

  it('a non-owner is refused: another app\'s owner, a team viewer, a visitor; no app is a 404 even for an admin', async () => {
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('w-app', 'private', '[\"moderator\"]', 1)").run();
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, invited_by, created_at) VALUES ('w-app', 'gh:teamviewer', 'viewer', 'gh:owner', 1)").run();
    expect((await get('/v1/apps/w-app/visibility', 'gh:other')).status).toBe(403);
    expect((await get('/v1/apps/w-app/visibility', 'gh:teamviewer')).status).toBe(403);
    expect((await get('/v1/apps/w-app/visibility')).status).toBe(401);
    expect((await get('/v1/apps/no-such-app/visibility', 'gh:admin', ['user', 'admin'])).status).toBe(404);
    // The visitor-scoped read is unchanged: mode only.
    expect(await (await get('/v1/apps/w-app/visibility/me', 'gh:other')).json()).toEqual({ mode: 'private', allowed: false });
  });
});
