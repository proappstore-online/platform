import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #426: deny-by-default for caller_unscoped actions, on real D1 and the real
// migrations. What an app registered before the gate is grandfathered from the
// app_tools row itself; only the app's data worker (/validate) is intercepted.

const getUser = {
  name: 'get_user',
  description: 'A user',
  operation: 'query',
  sql: 'SELECT id, name, email FROM users WHERE id = :id',
  params: { id: { type: 'string' } },
  requires_auth: true,
  auth: { caller_unscoped: { reason: 'profile page' } },
};
const listTags = {
  name: 'list_tags',
  description: 'Every tag',
  operation: 'query',
  sql: 'SELECT id, label FROM tags LIMIT 200',
  params: {},
  requires_auth: true,
  auth: { caller_unscoped: { reason: 'tags are shared' } },
};
const approval = { action: 'list_tags', reviewer: 'serge-ivo', date: '2026-10-20', reason: 'shared tag list, no personal data' };

function validates(): void {
  fetchMock.get(`https://pas-data-club.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
}
async function register(body: Record<string, unknown>): Promise<{ status: number; body: { error?: string; warnings?: string[] } }> {
  validates();
  const res = await SELF.fetch(`${BASE}/v1/apps/club/tools`, json('PUT', body, await session('gh:1')));
  return { status: res.status, body: (await res.json()) as { error?: string; warnings?: string[] } };
}
/** As the app was before #426: its rows written straight to app_tools. */
async function preRegistered(...tools: Record<string, unknown>[]): Promise<void> {
  for (const t of tools) {
    await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES ('club', ?, ?, 1, 1, 'code')")
      .bind(t.name, JSON.stringify(t)).run();
  }
}
const registered = async () => (await env.DB.prepare("SELECT name FROM app_tools WHERE app_id = 'club' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await seedUser('gh:1', 'owner');
  await seedApp('club', 'gh:1');
});

describe('caller_unscoped deny-by-default on real D1 (#426)', () => {
  it('refuses a new unapproved unscoped action and leaves the registered set untouched', async () => {
    await preRegistered({ ...listTags, auth: undefined, sql: 'SELECT id, label FROM tags WHERE user_id = :__user_id' });
    const r = await register({ tools: [listTags] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no approved_unscoped entry/);
    expect(await registered()).toEqual(['list_tags']);
    const row = await env.DB.prepare("SELECT manifest FROM app_tools WHERE app_id = 'club'").first<{ manifest: string }>();
    expect(JSON.parse(row!.manifest).auth).toBeUndefined();
  });

  it('registers an approved one', async () => {
    const r = await register({ tools: [listTags], approved_unscoped: [approval] });
    expect(r.status).toBe(200);
    expect(await registered()).toEqual(['list_tags']);
  });

  it('grandfathers what is already registered, warning [SECURITY] for personal data; a change to it is refused', async () => {
    await preRegistered(getUser, listTags);
    const kept = await register({ tools: [getUser, listTags] });
    expect(kept.status).toBe(200);
    expect(kept.body.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\[SECURITY\] tool "get_user" .*email/),
      '2 action(s) are caller_unscoped and require approval before next registration change: get_user, list_tags',
    ]));
    // The grandfathered rows were re-written by that deploy, so the next one is grandfathered too.
    expect((await register({ tools: [getUser, listTags] })).status).toBe(200);
    const changed = await register({ tools: [{ ...getUser, sql: 'SELECT id, name, email, phone FROM users WHERE id = :id' }, listTags] });
    expect(changed.status).toBe(400);
    expect(changed.body.error).toMatch(/"get_user" .*personal-data column\(s\) email, phone/);
  });
});
