import { SELF, env, fetchMock } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE, mockNetwork, seedApp, seedUser, session, resetTables, viaHostApi } from './helpers';
import { PARENTS_CLUBS, STASH } from '../../../backend/src/__fixtures__/operator-view';
import { operatorView } from '../../../backend/src/routes/operator-view';
import { toolsRoutes } from '../../../backend/src/routes/tools';

// #300: the admin console's security matrix, on workerd with real D1, for both
// sample apps (Stash, Parents Clubs). Every operator route — derived from each
// app's own contract, and checked against the routes the backend registers —
// times every caller: the owner, a declared admin (fresh and stale session), a
// moderator and a member holding every action role but not the admin role,
// another app's owner, #272 squatters, a signed-out caller, a cookie-only
// caller (CSRF) and a request mediated from an app page (CSRF via another
// app's origin). The data worker answers every query with a row that carries
// secret-like columns, so a field leak anywhere shows up as a sentinel.

type Sample = typeof STASH | typeof PARENTS_CLUBS;
type Tool = { name: string; step_up?: boolean };
type Resource = { id: string; action: string; series?: unknown; status?: { column: string }; detail?: { action: string; key: string; evidence?: { field: string }[] } };
type Action = { id: string; resource: string; action: string; transition?: { from: string[] } };
interface Route { template: string; method: 'GET' | 'POST'; path: string; body?: unknown; ownerOnly: boolean; stepUp: boolean }

const ADMIN_ROLE = 'support';
/** Every role either contract's actions, audit or review storage ask for. */
const ACTION_ROLES = ['operator', 'reviewer', 'moderator'];
const SECRET = 'SECRET-SENTINEL';
const SECRETS = { password_hash: SECRET, api_token: SECRET, session_secret: SECRET, private_key: SECRET };

/** One row the data worker returns for every query: every declared column, plus secrets nobody declared. */
const ROWS: Record<string, Record<string, unknown>> = {
  stash: {
    user_id: 'gh:10', display_name: 'Row-Ada', email: 'ada@row.test', pocket_count: 3, created_at: 1, suspended: 0,
    report_id: 'r1', reason: 'spam', details: 'd', reporter_id: 'gh:11', reported_user_id: 'gh:10', status: 'open',
    suspension_id: 's1', lifted_at: null, request_id: 'k1', full_name: 'Row-Ada', document_type: 'passport', submitted_at: 1,
    document_path: '_review/u/gh:10/id.png', selfie_path: '_review/u/gh:10/selfie.png',
    open_reports: 2, suspended_users: 1, day: Date.UTC(2026, 9, 1), plan: 'pro', signups: 4, ...SECRETS,
  },
  'parents-clubs': {
    user_id: 'p7', full_name: 'Row-Pat', club_name: 'Club', verified: 1, phone: '0700', joined_at: 1,
    flag_id: 'f1', post_title: 'Post', flagged_by: 'p8', state: 'new', flagged_at: 1, request_id: 'v1', parent_name: 'Row-Pat',
    submitted_at: 1, licence_path: '_review/u/p7/licence.pdf', reason: 'r', until: 2, clubs: 3, members: 9,
    week_start: Date.UTC(2026, 8, 28), attendance_rate: 0.5, events: 2, fees: 10, ...SECRETS,
  },
};
const APPS: [string, Sample][] = [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]];

/** Every operator route of one app, from its own contract. */
function routesOf(appId: string, sample: Sample): Route[] {
  const tools = new Map((sample.tools as Tool[]).map((t) => [t.name, t]));
  const stepUp = (action: string) => Boolean(tools.get(action)?.step_up);
  const view = sample.operator_view as unknown as { resources: Resource[]; actions: Action[] };
  const row = ROWS[appId]!;
  const base = `/v1/apps/${appId}`;
  const out: Route[] = [{ template: 'GET /apps/:appId/operator', method: 'GET', path: `${base}/operator`, ownerOnly: false, stepUp: false }];
  for (const r of view.resources) {
    if (r.series) {
      out.push({ template: 'GET /apps/:appId/operator/metrics/:resourceId', method: 'GET', path: `${base}/operator/metrics/${r.id}`, ownerOnly: false, stepUp: stepUp(r.action) });
      continue;
    }
    out.push({ template: 'GET /apps/:appId/operator/resources/:resourceId', method: 'GET', path: `${base}/operator/resources/${r.id}`, ownerOnly: false, stepUp: stepUp(r.action) });
    if (!r.detail) continue;
    const record = `${base}/operator/resources/${r.id}/records/${encodeURIComponent(String(row[r.detail.key]))}`;
    out.push({ template: 'GET /apps/:appId/operator/resources/:resourceId/records/:key', method: 'GET', path: record, ownerOnly: false, stepUp: stepUp(r.detail.action) });
    // A document always needs the passkey step-up (#244).
    for (const e of r.detail.evidence ?? []) {
      out.push({ template: 'GET /apps/:appId/operator/resources/:resourceId/records/:key/evidence/:field', method: 'GET', path: `${record}/evidence/${e.field}`, ownerOnly: false, stepUp: true });
    }
  }
  for (const a of view.actions) {
    const resource = view.resources.find((r) => r.id === a.resource)!;
    const actionRow = { ...row, ...(a.transition && resource.status ? { [resource.status.column]: a.transition.from[0] } : {}) };
    out.push({ template: 'POST /apps/:appId/operator/actions/:actionId', method: 'POST', path: `${base}/operator/actions/${a.id}`, body: { row: actionRow }, ownerOnly: false, stepUp: stepUp(a.action) });
  }
  out.push(
    { template: 'POST /apps/:appId/operator/entries', method: 'POST', path: `${base}/operator/entries`, body: { visit: `visit-${appId}` }, ownerOnly: false, stepUp: false },
    { template: 'GET /apps/:appId/operator/audit', method: 'GET', path: `${base}/operator/audit`, ownerOnly: true, stepUp: false },
    { template: 'GET /apps/:appId/operator/users', method: 'GET', path: `${base}/operator/users`, ownerOnly: true, stepUp: false },
    { template: 'GET /apps/:appId/operator-view/inspect', method: 'GET', path: `${base}/operator-view/inspect`, ownerOnly: true, stepUp: false },
    ...(['preview', 'propose', 'security'] as const).map((verb) => ({
      template: `POST /apps/:appId/operator-view/${verb}`, method: 'POST' as const, path: `${base}/operator-view/${verb}`, body: { operator_view: sample.operator_view }, ownerOnly: true, stepUp: false,
    })),
  );
  return out;
}

const fresh = (uid: string, login: string) => mintSession(
  { uid, login, avatarUrl: null, roles: ['user', 'creator'], auth_time: Math.floor(Date.now() / 1000) - 5, auth_method: 'passkey' } as never, env.SESSION_SIGNING_KEY);

function call(route: Route, headers: Record<string, string>): Promise<Response> {
  // A request an app page made carries X-PAS-App, which only the host can send: it comes through HostApi (#315).
  const send = 'X-PAS-App' in headers ? viaHostApi : (url: string, init: RequestInit) => SELF.fetch(url, init);
  return send(`${BASE}${route.path}`, {
    method: route.method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
  });
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const trail = async (appId: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM app_action_audit WHERE app_id = ?').bind(appId).first<{ n: number }>())!.n;

beforeAll(() => {
  mockNetwork();
  // Persistent: the matrix makes hundreds of calls; each answer is the same row.
  for (const [appId] of APPS) {
    const worker = fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
    worker.intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) })).persist();
    worker.intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [ROWS[appId]], meta: {} }).persist();
    worker.intercept({ path: '/execute', method: 'POST' }).reply(200, { meta: { changes: 1 } }).persist();
    worker.intercept({ path: '/batch', method: 'POST' }).reply(200, { results: Array.from({ length: 8 }, () => ({ meta: { changes: 1 } })) }).persist();
  }
});

beforeEach(async () => {
  await resetTables();
  for (const t of ['app_operator_view', 'app_action_audit', 'app_storage_config', 'storage_review_access']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const [uid, login] of [['gh:1', 'owner'], ['gh:2', 'other-owner'], ['gh:4', 'admina'], ['gh:6', 'moder'], ['gh:7', 'memb']]) await seedUser(uid, login);
  await seedApp('bingo', 'gh:2');
  for (const [appId, sample] of APPS) {
    await seedApp(appId, 'gh:1');
    const contract = { ...sample, operator_view: { ...sample.operator_view, admin_access: { roles: [ADMIN_ROLE] } } };
    const put = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...bearer(await session('gh:1')) }, body: JSON.stringify(contract) });
    expect(put.status, await put.clone().text()).toBe(200);
    const grants: [string, string][] = [
      ...ACTION_ROLES.map((r) => ['gh:1', r] as [string, string]),
      ...[ADMIN_ROLE, ...ACTION_ROLES].map((r) => ['gh:4', r] as [string, string]),
      // The moderator holds every action role and member — only the declared admin role is missing.
      ...[...ACTION_ROLES, 'member'].map((r) => ['gh:6', r] as [string, string]),
      ['gh:7', 'member'],
      // Another app's owner holds everything, the admin role included, on their own app only.
      ...[ADMIN_ROLE, ...ACTION_ROLES].map((r) => ['gh:2', r] as [string, string]),
    ];
    await env.DB.batch(grants.map(([uid, role]) => env.DB.prepare('INSERT OR IGNORE INTO app_roles (app_id, user_id, role_name) VALUES (?, ?, ?)')
      .bind(uid === 'gh:2' ? 'bingo' : appId, uid, role)));
    const cfg = await SELF.fetch(`${BASE}/v1/apps/${appId}/storage-config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...bearer(await session('gh:1')) }, body: JSON.stringify({ review_roles: ['operator'] }) });
    expect(cfg.status).toBe(200);
  }
  await env.STORAGE.put('stash/_review/u/gh:10/id.png', 'PNGDATA', { httpMetadata: { contentType: 'image/png' } });
  await env.STORAGE.put('stash/_review/u/gh:10/selfie.png', 'SELFIEDATA', { httpMetadata: { contentType: 'image/png' } });
  await env.STORAGE.put('parents-clubs/_review/u/p7/licence.pdf', '%PDF-1', { httpMetadata: { contentType: 'application/pdf' } });
});

describe('the matrix covers every operator route the backend registers (#300)', () => {
  it('each registered operator and authoring route appears in both apps\' generated routes', () => {
    const registered = [
      ...operatorView.routes.filter((r) => r.method !== 'ALL'),
      ...toolsRoutes.routes.filter((r) => r.path.includes('/operator-view/') && r.path.startsWith('/apps/')),
    ].map((r) => `${r.method} ${r.path}`);
    expect(registered.length).toBeGreaterThanOrEqual(13);
    for (const [appId, sample] of APPS) {
      const covered = new Set(routesOf(appId, sample).map((r) => r.template));
      for (const route of registered) expect(covered.has(route), `${appId}: ${route}`).toBe(true);
    }
  });
});

for (const [appId, sample] of APPS) {
  const routes = routesOf(appId, sample);

  // Hundreds of requests per test; a slow, loaded machine must not turn them into failures.
  describe(`${appId}: route × role matrix (#300)`, { timeout: 120_000 }, () => {
    async function expectEverywhere(headers: Record<string, string>, status: 401 | 403) {
      for (const route of routes) {
        const res = await call(route, headers);
        const text = await res.text();
        expect(res.status, `${route.method} ${route.path}: ${text}`).toBe(status);
        expect(text, route.path).not.toMatch(/Row-|SENTINEL|"contract"|"rows"|"record"|"series"|"users"|PNGDATA|%PDF/);
      }
      expect(await trail(appId), 'nothing joins the audit trail').toBe(0);
    }

    it('owner: every route answers 200, and no secret-like column ever leaves', async () => {
      const token = await fresh('gh:1', 'owner');
      for (const route of routes) {
        const res = await call(route, bearer(token));
        const text = await res.text();
        expect(res.status, `${route.method} ${route.path}: ${text}`).toBe(200);
        expect(text, route.path).not.toMatch(/SENTINEL|password_hash|api_token|session_secret|private_key/);
      }
    });

    it('declared admin: admitted everywhere but the owner-only routes (audit trail, users, authoring)', async () => {
      const token = await fresh('gh:4', 'admina');
      for (const route of routes) {
        const res = await call(route, bearer(token));
        const text = await res.text();
        expect(res.status, `${route.method} ${route.path}: ${text}`).toBe(route.ownerOnly ? 403 : 200);
        expect(text, route.path).not.toMatch(/SENTINEL|password_hash|api_token|session_secret|private_key/);
      }
    });

    it('declared admin with a stale session: every step-up route refuses with step_up_required, the rest are unchanged', async () => {
      const token = await session('gh:4', { login: 'admina' });
      for (const route of routes) {
        const res = await call(route, bearer(token));
        const text = await res.text();
        const expected = route.ownerOnly || route.stepUp ? 403 : 200;
        expect(res.status, `${route.method} ${route.path}: ${text}`).toBe(expected);
        if (route.stepUp && !route.ownerOnly) expect(text, route.path).toContain('step_up_required');
        if (expected === 403) expect(text, route.path).not.toMatch(/Row-|SENTINEL|PNGDATA|%PDF/);
      }
    });

    it('moderator and member — holding every action role but not the declared admin role — are refused everywhere', async () => {
      await expectEverywhere(bearer(await fresh('gh:6', 'moder')), 403);
      await expectEverywhere(bearer(await fresh('gh:7', 'memb')), 403);
    });

    it("another app's owner, holding the admin role on their own app, is refused everywhere", async () => {
      await expectEverywhere(bearer(await fresh('gh:2', 'other-owner')), 403);
    });

    it('#272 squatters: a credential or Google account named after the admin, or the owner, is refused everywhere', async () => {
      // A legacy grant keyed by the admin's GitHub login admits only the GitHub session with that login.
      await env.DB.prepare('INSERT INTO app_roles (app_id, user_id, role_name) VALUES (?, ?, ?)').bind(appId, 'admina', ADMIN_ROLE).run();
      for (const [uid, login] of [['cred:squat', 'admina'], ['google:squat', 'gh:4'], ['cred:owner', 'owner'], ['google:owner', 'gh:1']]) {
        await expectEverywhere(bearer(await fresh(uid, login)), 403);
      }
    });

    it('signed out, forged, expired and wrongly signed sessions → 401 everywhere', async () => {
      await expectEverywhere({}, 401);
      const claims = { uid: 'gh:1', login: 'owner', avatarUrl: null, roles: ['user'] };
      for (const token of ['not-a-session', await mintSession(claims, env.SESSION_SIGNING_KEY, -60), await mintSession(claims, 'not-the-signing-key')]) {
        await expectEverywhere(bearer(token), 401);
      }
    });

    it("CSRF: the owner's session in a cookie, or in the query string, is not a credential → 401 everywhere", async () => {
      const token = await fresh('gh:1', 'owner');
      await expectEverywhere({ Cookie: `__Host-pas_session=${token}; pas_session=${token}` }, 401);
      for (const route of routes) {
        const res = await call({ ...route, path: `${route.path}?token=${token}&access_token=${token}` }, { Origin: 'https://evil.example' });
        expect(res.status, route.path).toBe(401);
        expect(res.headers.get('Access-Control-Allow-Origin'), route.path).toBeNull();
        await res.text();
      }
    });

    it("CSRF via an app page: a request the host mediated from any app's origin is refused, even with the owner's fresh session", async () => {
      const token = await fresh('gh:1', 'owner');
      for (const origin of [appId, 'bingo']) await expectEverywhere({ ...bearer(token), 'X-PAS-App': origin }, 403);
    });
  });
}

describe('CSRF: CORS on the operator routes (#300)', { timeout: 60_000 }, () => {
  it('a foreign origin gets no CORS grant for a preflight or a credentialed call; the console origin does', async () => {
    const path = `${BASE}/v1/apps/stash/operator/actions/suspend_member`;
    const preflight = (origin: string) => SELF.fetch(path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    for (const origin of ['https://evil.example', 'https://proappstore.online.evil.example', 'https://freeappstore.online']) {
      const res = await preflight(origin);
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
      await res.text();
    }
    const console = await preflight('https://console.proappstore.online');
    expect(console.headers.get('Access-Control-Allow-Origin')).toBe('https://console.proappstore.online');
    await console.text();
  });
});
