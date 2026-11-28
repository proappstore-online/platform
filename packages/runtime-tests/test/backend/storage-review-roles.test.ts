import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

/**
 * #696: review-document access and a private app's `visibility.roles` read the
 * shared heldAppRoles, so the owner holds the roles the app declares there too;
 * an app may declare its review roles in mcp.json `storage.review_roles`, which
 * registration writes to app_storage_config and PUT storage-config then cannot
 * change. Real registration (PUT /tools), real D1 and R2.
 */
const DOC = 'rides/_review/u/gh:5/licence.pdf';
afterEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  await env.STORAGE.delete(DOC);
});
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_declared_roles', 'app_storage_config', 'storage_review_access', 'app_visibility']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const [uid, login] of [['gh:1', 'owner'], ['gh:2', 'ops'], ['gh:3', 'rider'], ['gh:5', 'driver']]) await seedUser(uid!, login);
  await seedApp('rides', 'gh:1');
  await env.STORAGE.put(DOC, '%PDF-1', { httpMetadata: { contentType: 'application/pdf' } });
});

const ROLES = [{ id: 'ops', label: 'Operations' }, { id: 'ops_pii', label: 'Rider PII', requires: ['ops'] }];
const register = async (body: Record<string, unknown>) =>
  SELF.fetch(`${BASE}/v1/apps/rides/tools`, json('PUT', { tools: [], ...body }, await session('gh:1')));
const config = async () => (await SELF.fetch(`${BASE}/v1/apps/rides/storage-config`, json('GET', undefined, await session('gh:1')))).json();
const putConfig = async (body: unknown) => SELF.fetch(`${BASE}/v1/apps/rides/storage-config`, json('PUT', body, await session('gh:1')));
const readDoc = async (uid: string) => SELF.fetch(`${BASE}/v1/apps/rides/storage/_review/u/gh%3A5/licence.pdf`, json('GET', undefined, await session(uid)));
const trail = async () => (await env.DB.prepare("SELECT owner_id, path, actor_id, action FROM storage_review_access WHERE app_id = 'rides' ORDER BY id").all()).results;

describe('storage.review_roles in mcp.json (#696)', () => {
  it('registration writes the review roles and locks them against PUT storage-config; retention stays editable', async () => {
    const reg = await register({ roles: ROLES, storage: { review_roles: ['ops'] } });
    expect(reg.status, await reg.clone().text()).toBe(200);
    expect(await reg.json()).toMatchObject({ roles: ['ops', 'ops_pii'], storage: { review_roles: ['ops'] } });
    expect(await config()).toEqual({ review_roles: ['ops'], review_roles_from_manifest: true, review_retention_days: null, effective_review_retention_days: 30 });

    const changed = await putConfig({ review_roles: ['ops', 'ops_pii'] });
    expect(changed.status).toBe(409);
    expect(await changed.text()).toContain('storage.review_roles');
    // What Rideshare's Staff screen sends after reading the config: the same list is accepted as a no-op.
    expect((await putConfig({ review_roles: ['ops'] })).status).toBe(200);
    expect((await putConfig({ review_retention_days: 14 })).status).toBe(200);
    expect(await config()).toEqual({ review_roles: ['ops'], review_roles_from_manifest: true, review_retention_days: 14, effective_review_retention_days: 14 });

    // A redeploy rewrites the roles and keeps the retention.
    expect((await register({ roles: ROLES, storage: { review_roles: ['ops_pii'] } })).status).toBe(200);
    expect(await config()).toMatchObject({ review_roles: ['ops_pii'], review_roles_from_manifest: true, review_retention_days: 14 });
  });

  it('refuses a review role the app does not declare, with the manifest error shape, and keeps the stored config', async () => {
    expect((await register({ roles: ROLES, storage: { review_roles: ['ops'] } })).status).toBe(200);
    const typo = await register({ roles: ROLES, storage: { review_roles: ['opps'] } });
    expect(typo.status).toBe(400);
    expect(await typo.json()).toEqual({ error: 'storage.review_roles: role "opps" is not declared in roles' });
    const member = await register({ storage: { review_roles: ['member'] } });
    expect(await member.json()).toEqual({ error: "storage.review_roles cannot include 'member' (every signed-in user holds it)" });
    expect(await config()).toMatchObject({ review_roles: ['ops'], review_roles_from_manifest: true });
  });

  it('an app without the block is unchanged; dropping the block hands the roles back to the team as they were', async () => {
    expect((await putConfig({ review_roles: ['verifier'] })).status).toBe(200);
    expect((await register({})).status).toBe(200);
    expect(await config()).toMatchObject({ review_roles: ['verifier'], review_roles_from_manifest: false });

    expect((await register({ roles: ROLES, storage: { review_roles: ['ops'] } })).status).toBe(200);
    expect((await register({ roles: ROLES })).status).toBe(200);
    expect(await config()).toMatchObject({ review_roles: ['ops'], review_roles_from_manifest: false });
    expect((await putConfig({ review_roles: ['ops', 'ops_pii'] })).status).toBe(200);

    // DELETE /tools releases the lock the same way.
    expect((await register({ roles: ROLES, storage: { review_roles: ['ops'] } })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/apps/rides/tools`, json('DELETE', undefined, await session('gh:1')))).status).toBe(200);
    expect(await config()).toMatchObject({ review_roles: ['ops'], review_roles_from_manifest: false });
  });
});

describe('the owner holds declared review roles (#696)', () => {
  it('opens a driver document under a declared review role, audited like any reviewer; nobody else without a grant', async () => {
    expect((await register({ roles: ROLES, storage: { review_roles: ['ops'] } })).status).toBe(200);
    const owner = await readDoc('gh:1');
    expect(owner.status, await owner.clone().text()).toBe(200);
    expect(await owner.text()).toBe('%PDF-1');
    expect((await readDoc('gh:3')).status).toBe(403);

    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('rides', 'gh:2', 'ops')").run();
    expect((await readDoc('gh:2')).status).toBe(200);
    expect(await trail()).toEqual([
      { owner_id: 'gh:5', path: 'licence.pdf', actor_id: 'gh:1', action: 'read' },
      { owner_id: 'gh:5', path: 'licence.pdf', actor_id: 'gh:2', action: 'read' },
    ]);
  });

  it('an app with no roles block keeps today’s behaviour: the owner needs a grant', async () => {
    expect((await register({ storage: { review_roles: ['ops'] } })).status).toBe(200);
    expect((await readDoc('gh:1')).status).toBe(403);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('rides', 'gh:1', 'ops')").run();
    expect((await readDoc('gh:1')).status).toBe(200);
  });

  it('a declared role that is not a review role opens nothing', async () => {
    expect((await register({ roles: ROLES, storage: { review_roles: ['ops_pii'] } })).status).toBe(200);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('rides', 'gh:2', 'ops')").run();
    expect((await readDoc('gh:2')).status).toBe(403);
    expect((await readDoc('gh:1')).status).toBe(200); // the owner holds ops_pii by declaration
  });
});

describe('private-app visibility.roles through heldAppRoles (#696)', () => {
  const LOGINS: Record<string, string> = { 'gh:1': 'owner', 'gh:2': 'ops', 'gh:3': 'rider', 'gh:5': 'driver' };
  const allowed = async (uid: string) =>
    ((await (await SELF.fetch(`${BASE}/v1/apps/rides/visibility/me`, json('GET', undefined, await session(uid, { login: LOGINS[uid] })))).json()) as { allowed: boolean }).allowed;

  it('admits the owner and a holder of a listed role, by id or by GitHub login; refuses everyone else', async () => {
    expect((await register({ roles: ROLES, visibility: { mode: 'private', roles: ['ops'] } })).status).toBe(200);
    expect(await allowed('gh:1')).toBe(true);
    expect(await allowed('gh:2')).toBe(false);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('rides', 'gh:2', 'ops'), ('rides', 'rider', 'ops')").run();
    expect(await allowed('gh:2')).toBe(true);
    expect(await allowed('gh:3')).toBe(true); // granted to the GitHub login before first sign-in (#272)
    expect(await allowed('gh:5')).toBe(false);
    await env.DB.prepare("UPDATE app_roles SET role_name = 'ops_pii' WHERE app_id = 'rides' AND user_id = 'gh:2'").run();
    expect(await allowed('gh:2')).toBe(false); // an unlisted role, declared or not, admits nobody
  });
});
