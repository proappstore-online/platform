import { SELF, env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { createProvisioningWorkflow } from '../../../mcp/src/provisioning-workflow';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = testEnv as unknown as Env;

// #370 on real D1 through the real backend routes: the provisioning preview's
// `appRecord` is whose PAS app record it is, read from the apps table — not the
// status of an admin-authorised read. The workflow is the production MCP module;
// every backend call (ownership via /v1/apps, the record-state read) reaches the
// real API worker. Only GitHub is a fake, and its write methods throw.

const ORG = 'proappstore-online';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
const ghWrites = vi.fn(() => { throw new Error('preview must not write to GitHub'); });
const gh = {
  api: vi.fn(async (path: string) => {
    if (/^\/repos\/proappstore-online\/[a-z0-9-]+$/.test(path)) return { ok: true, status: 200, data: { id: 1, private: true } };
    if (/\/commits\?per_page=2$/.test(path)) return { ok: true, status: 200, data: [{ sha: 'scaffold-head', commit: { tree: { sha: TREE } } }] };
    if (path.startsWith(`/repos/${ORG}/template-app/commits/`)) return { ok: true, status: 200, data: { sha: HEAD, commit: { tree: { sha: TREE } } } };
    return { ok: false, status: 404, data: {} };
  }),
  repoExists: vi.fn(async () => true),
  createRepoFromTemplate: ghWrites,
  pushFiles: ghWrites,
  putFile: ghWrites,
  deleteFile: ghWrites,
};

/** The real API worker as the MCP worker's API service binding sees it; `failRecord` simulates an outage of the record read. */
let failRecord = false;
const api = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    if (failRecord && String(input).endsWith('/record-state')) return Promise.resolve(new Response('unavailable', { status: 503 }));
    return SELF.fetch(input, init);
  },
};
const workflow = () => createProvisioningWorkflow({ GITHUB_ORG: ORG, API_BASE: BASE, API: api as unknown as Fetcher, HOST: api as unknown as Fetcher }, gh as never);
const admin = async () => ({ userId: 'gh:admin', token: await session('gh:admin', { roles: ['user', 'admin'] }), roles: ['user', 'admin'] });
const creator = async (uid = 'gh:1') => ({ userId: uid, token: await session(uid), roles: ['user', 'creator'] });
async function preview(user: { userId: string; token: string; roles: string[] }, appId: string) {
  const outcome = await workflow().planProvision(user, { appId, name: 'App', description: 'An app.', template: 'template-app', repoUrl: `https://github.com/${ORG}/${appId}` }, { mode: 'console', privateRepo: true });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.plan;
}
const counts = async () => Object.fromEntries(await Promise.all(['apps', 'app_listings', 'team_members', 'provision_operations', 'provisioning_plans'].map(async (t) =>
  [t, (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n] as const)));

beforeEach(async () => {
  mockNetwork();
  // verifyAppOwnership (ownsApp) reads GET /v1/apps with the global fetch: route it to the real API worker too.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input, init));
  failRecord = false;
  ghWrites.mockClear();
  await resetTables();
  for (const t of ['app_listings', 'team_members', 'provision_operations', 'provisioning_plans']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const uid of ['gh:admin', 'gh:1', 'gh:2', 'gh:3']) await seedUser(uid);
  await seedApp('admins-app', 'gh:admin');
  await seedApp('theirs', 'gh:2');
  await seedApp('team-app', 'gh:2');
  await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, invited_by, created_at) VALUES ('team-app', 'gh:3', 'owner', 'gh:2', 1)").run();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('admin provisioning previews report the actual app record (#370)', () => {
  it('admin + no apps row: the record is none, though admin support may still reuse the repo', async () => {
    // The listing route still answers an admin 200 with an empty DTO for an absent id — unchanged, and no longer consulted.
    const listing = await SELF.fetch(`${BASE}/v1/apps/absent-app/listing`, json('GET', undefined, (await admin()).token));
    expect(listing.status).toBe(200);
    expect(await preview(await admin(), 'absent-app')).toMatchObject({ action: 'reuse_admin', appRecord: 'none', blockers: [] });
  });

  it('admin + another user\'s app: authorisation to operate it is not reported as ownership', async () => {
    expect(await preview(await admin(), 'theirs')).toMatchObject({ action: 'reuse_admin', appRecord: 'other', blockers: [] });
  });

  it('admin + their own app: owner', async () => {
    expect(await preview(await admin(), 'admins-app')).toMatchObject({ action: 'reuse_owned', appRecord: 'owner' });
  });

  it('non-admin: another\'s app is refused, an absent record is the orphan case, a team owner owns it', async () => {
    const other = await preview(await creator(), 'theirs');
    expect(other).toMatchObject({ action: 'refused', appRecord: 'other' });
    expect(other.blockers.map((b) => b.code)).toEqual(['owned_by_another_account']);
    expect(other.repository).toEqual({ owner: ORG, name: 'theirs', url: `https://github.com/${ORG}/theirs`, exists: true });
    expect(await preview(await creator(), 'absent-app')).toMatchObject({ action: 'adopt_untouched', appRecord: 'none', blockers: [] });
    expect(await preview(await creator('gh:3'), 'team-app')).toMatchObject({ action: 'reuse_owned', appRecord: 'owner' });
  });

  it('a failed record lookup stays unknown: truthful for an admin, refused for anyone else', async () => {
    failRecord = true;
    expect(await preview(await admin(), 'absent-app')).toMatchObject({ action: 'reuse_admin', appRecord: 'unknown' });
    const refused = await preview(await creator(), 'absent-app');
    expect(refused).toMatchObject({ action: 'refused', appRecord: 'unknown' });
    expect(refused.blockers.map((b) => b.code)).toEqual(['app_record_unavailable']);
  });

  it('previews change no app, listing, team, receipt, plan or repository', async () => {
    const before = await counts();
    for (const [user, appId] of [[await admin(), 'absent-app'], [await admin(), 'theirs'], [await admin(), 'admins-app'], [await creator(), 'theirs'], [await creator(), 'absent-app']] as const) {
      await preview(user, appId);
    }
    expect(await counts()).toEqual(before);
    expect(ghWrites).not.toHaveBeenCalled();
  });

  it('the plan keeps the template revision, the reviewed commit and the repo head as separate facts', async () => {
    const plan = await preview(await creator(), 'absent-app');
    expect(plan.template.revision).toBe(HEAD); // proven by the scaffold's tree
    expect(plan.template.reviewedCommit).not.toBe(plan.template.revision);
    expect(plan.repository.headSha).toBe('scaffold-head');
    expect(plan.appRecord).toBe('none'); // a tree match proves provenance, never ownership
  });
});

describe('GET /v1/apps/:appId/record-state', () => {
  const read = async (appId: string, token?: string) => SELF.fetch(`${BASE}/v1/apps/${appId}/record-state`, json('GET', undefined, token));
  it('answers from the apps table, ignoring the admin role', async () => {
    const adminToken = (await admin()).token;
    for (const [appId, token, state] of [
      ['absent-app', adminToken, 'none'], ['theirs', adminToken, 'other'], ['admins-app', adminToken, 'owner'],
      ['theirs', await session('gh:1'), 'other'], ['absent-app', await session('gh:1'), 'none'],
      ['team-app', await session('gh:3'), 'owner'], ['theirs', await session('gh:2'), 'owner'],
    ] as const) {
      const res = await read(appId, token);
      expect(res.status, `${appId}`).toBe(200);
      expect(await res.json()).toEqual({ appId, state });
    }
  });
  it('needs a session and a valid id', async () => {
    expect((await read('theirs')).status).toBe(401);
    expect((await read('Bad_Id', await session('gh:1'))).status).toBe(400);
  });
});
