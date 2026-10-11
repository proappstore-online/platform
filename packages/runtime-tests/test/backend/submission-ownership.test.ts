import { SELF, env as testEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = testEnv as unknown as Env;

// #382 on real D1, through the real routes: approving a submission provisions
// the app for the SUBMITTER. The approving admin is never recorded as its owner,
// and the submitter reaches owner-only routes afterwards. Only Cloudflare's
// D1-create call is intercepted, so provisionData reaches its record_app step.

const DEV = 'gh:dev';
const ADMIN = 'gh:admin'; // ADMIN_GITHUB_IDS in vitest.backend.ts
const OTHER = 'gh:other';

async function approve(appId: string) {
  const row = await env.DB.prepare("SELECT id FROM submissions WHERE app_id = ? AND status = 'pending'").bind(appId).first<{ id: string }>();
  fetchMock.get('https://api.cloudflare.com').intercept({ path: `/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database`, method: 'POST' })
    .reply(200, { success: true, result: { uuid: `d1-${appId}` } });
  const res = await SELF.fetch(`${BASE}/v1/submissions/${row!.id}/approve`, json('POST', {}, await session(ADMIN, { roles: ['user', 'creator', 'admin'] })));
  expect(res.status).toBe(200);
  return res.json<{ provisionResult: { steps?: { name: string; status: string; detail: string }[]; error?: string; status?: number } }>();
}
const creator = (appId: string) =>
  env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(appId).first<{ creator_id: string }>();
const alerts = async (appId: string, uid: string) =>
  (await SELF.fetch(`${BASE}/v1/apps/${appId}/alerts`, json('GET', undefined, await session(uid, { roles: ['user', 'creator'] })))).status;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['submissions', 'provision_attempts', 'dev_profiles']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const uid of [DEV, ADMIN, OTHER]) await seedUser(uid);
});

describe('approval provisions the app for its submitter (#382)', () => {
  it('records the submitter as creator, never the approving admin', async () => {
    const submitted = await SELF.fetch(`${BASE}/v1/submissions`, json('POST', { appId: 'dev-app', name: 'App', category: 'productivity', description: 'desc' }, await session(DEV)));
    expect(submitted.status).toBe(201);
    const approved = await approve('dev-app');
    expect(approved.provisionResult.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'record_app', status: 'ok', detail: expect.stringContaining(`creator: ${DEV}`) }),
    ]));

    expect(await creator('dev-app')).toEqual({ creator_id: DEV });
    expect(await env.DB.prepare('SELECT 1 FROM team_members WHERE app_id = ? AND user_id = ?').bind('dev-app', ADMIN).first()).toBeNull();
    expect(await env.DB.prepare('SELECT creator_id FROM dev_profiles').all()).toMatchObject({ results: [{ creator_id: DEV }] });
  });

  it('lets the submitter reach owner-only routes for their app, and nobody else', async () => {
    await SELF.fetch(`${BASE}/v1/submissions`, json('POST', { appId: 'dev-app', name: 'App', category: 'productivity', description: 'desc' }, await session(DEV)));
    await approve('dev-app');
    expect(await alerts('dev-app', DEV)).toBe(200);
    expect(await alerts('dev-app', OTHER)).toBe(403);
  });

  it('never lands an approval on an app another user already owns', async () => {
    await seedApp('taken-app', OTHER);
    await env.DB.prepare(
      "INSERT INTO submissions (id, app_id, creator_id, status, name, category, description, created_at) VALUES ('sub-taken', 'taken-app', ?, 'pending', 'T', 'c', 'd', ?)",
    ).bind(DEV, Date.now()).run();
    const approved = await approve('taken-app');
    expect(approved.provisionResult).toEqual({ error: 'appId already claimed by another user', status: 403 });
    expect(await creator('taken-app')).toEqual({ creator_id: OTHER });
    const status = await env.DB.prepare("SELECT status FROM submissions WHERE id = 'sub-taken'").first<{ status: string }>();
    expect(status?.status).not.toBe('published');
  });
});
