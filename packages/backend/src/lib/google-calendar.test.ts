import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, testToken } from '../test-helpers.js';
import type { Env } from '../types.js';
import { workerGoogleCalendar } from './google-calendar-worker.js';
import { GOOGLE_CALENDAR_SCOPES, googleJson, hashState, resourceReceipt, verifyResourceReceipt } from './google-calendar-common.js';
import { googleCalendarRoutes } from '../routes/google-calendar.js';
import { deleteAppAccountRoutes } from '../routes/delete-app-account.js';
import { Hono } from 'hono';
import { replaceAppTools } from '../routes/tools.js';
import { credentialContext, mintSession } from '@proappstore/build-core';

const KEK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const USER = 'gh:1', OTHER = 'gh:2';
const now = Date.parse('2026-11-04T12:00:00Z');
let db: ReturnType<typeof sqliteD1>, env: Env, requests: URL[];
let fetcher: ReturnType<typeof vi.fn>;
const actor = (id = USER) => ({ id, roles: ['user'] });
const call = (input: Record<string, unknown>, app = 'hiring', caller: ReturnType<typeof actor> | null = actor()) => workerGoogleCalendar(env, app, 'calendar', input, caller);
const meeting = () => ({ id: 'event1', status: 'confirmed', start: { dateTime: new Date(now - 7_200_000).toISOString() }, end: { dateTime: new Date(now - 3_600_000).toISOString() }, hangoutLink: 'https://meet.google.com/abc-defg-hij' });
async function provider(raw: URL | string, init: RequestInit = {}) {
  const url = new URL(raw); requests.push(url);
  if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' ') });
  if (url.pathname.endsWith('/userinfo')) return Response.json({ sub: '123456', email: 'organizer@example.test', email_verified: true });
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer private-access');
  if (url.pathname.endsWith('/calendarList')) return Response.json({ items: [{ id: 'team@example.test', summary: 'Recruiting', primary: true, accessRole: 'owner' }] });
  if (url.pathname.includes('/calendarList/')) return Response.json({ id: decodeURIComponent(url.pathname.split('/').at(-1)!), summary: 'Recruiting', accessRole: 'owner' });
  if (url.pathname.endsWith('/events/event1')) return Response.json(meeting());
  if (url.pathname.endsWith('/events')) return Response.json({ items: [meeting()] });
  if (url.pathname.endsWith('/conferenceRecords')) return Response.json({ conferenceRecords: [{ name: 'conferenceRecords/record1', startTime: meeting().start.dateTime, endTime: meeting().end.dateTime }] });
  if (url.pathname.endsWith('/participants')) return Response.json({ participants: [{ name: 'conferenceRecords/record1/participants/person1', signedinUser: { user: 'users/123456', displayName: 'Private name' } }, { name: 'conferenceRecords/record1/participants/anon', anonymousUser: { displayName: 'Private guest' } }] });
  if (url.pathname.endsWith('/participantSessions')) return Response.json({ participantSessions: [{ name: 'conferenceRecords/record1/participants/person1/participantSessions/session1', startTime: meeting().start.dateTime, endTime: meeting().end.dateTime }] });
  throw new Error(`Unexpected test request ${url.pathname}`);
}
const consentRouter = new Hono<{ Bindings: Env }>().route('/v1', googleCalendarRoutes);
const API = 'https://api.proappstore.online';
const disclosure = { purpose: 'Show selected meeting records in this app.', audience: 'Authorized organization members can see meeting records.', retention: 'The app operator describes retained records in its privacy notice.', privacy_path: '/privacy', deletion_path: '/settings/data' };
async function approve(state: string, capabilities = ['calendar.read', 'meet.read'], userId = USER) {
  const token = await mintSession({ uid: userId, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  const session = await consentRouter.request(`${API}/v1/connectors/google-calendar/session?state=${state}`, { method: 'POST', headers: { Origin: API, Authorization: `Bearer ${token}` } }, env);
  expect(session.status).toBe(200);
  const cookie = session.headers.get('Set-Cookie')!.split(';')[0]!;
  const page = await consentRouter.request(`${API}/v1/connectors/google-calendar/consent?state=${state}`, { headers: { Cookie: cookie } }, env);
  const content = await page.text();
  expect(page.status, content).toBe(200);
  expect(content).toContain('name="csrf"');
  const csrf = content.match(/name="csrf" value="([^"]+)"/)![1]!;
  const body = new FormData(); body.set('csrf', csrf); body.set('decision', 'allow');
  for (const capability of capabilities) body.append('capability', capability);
  const response = await consentRouter.request(`${API}/v1/connectors/google-calendar/consent?state=${state}`, { method: 'POST', headers: { Origin: API, Cookie: cookie }, body }, env);
  expect(response.status).toBe(302);
  return { cookie, url: new URL(response.headers.get('Location')!) };
}
async function approvedStart(input: Record<string, unknown>) {
  const result = await call(input);
  if (typeof result.authorization_url !== 'string') return { ...result, cookie: '', google_url: new URL(API) };
  const accepted = await approve(new URL(result.authorization_url).searchParams.get('state')!);
  return { ...result, cookie: accepted.cookie, google_url: accepted.url };
}
async function connect() {
  const start = await approvedStart({ operation: 'start', callback_path: '/recruiter/google-calendar/callback', return_to: '/recruiter/settings' });
  const url = start.google_url, state = url.searchParams.get('state')!;
  const result = await call({ operation: 'complete', state, code: 'one-use-code' });
  expect(result).toEqual({ return_to: '/recruiter/settings', email: 'organizer@example.test' });
  return { state, url };
}
async function grant() {
  await connect();
  const result = await call({ operation: 'grant', calendar_id: 'team@example.test' });
  expect(result.grant_id).toBeTypeOf('string');
  return result.grant_id as string;
}
async function deleteAppAccount(appId = 'hiring', userId = USER) {
  const router = new Hono<{ Bindings: Env }>().route('/v1', deleteAppAccountRoutes);
  const response = await router.request(`/v1/apps/${appId}/users/${encodeURIComponent(userId)}/account`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${await testToken(userId)}` },
  }, { ...env, STORAGE: { list: async () => ({ objects: [], truncated: false }) } } as unknown as Env);
  expect(response.status).toBe(200);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:1','github','1','owner',0,0),('gh:2','github','2','other',0,0);
    INSERT INTO apps (id,creator_id,created_at) VALUES ('hiring','gh:1',0),('other','gh:2',0);
    INSERT INTO app_connectors (app_id,name,kind,modes,events,created_at) VALUES ('hiring','calendar','google_calendar','["oauth"]','[]',0),('other','calendar','google_calendar','["oauth"]','[]',0);`);
  env = makeEnv({ DB: db, APP_SECRET_KEK: KEK, GOOGLE_CLIENT_ID: 'platform-google-id', GOOGLE_CLIENT_SECRET: 'platform-google-secret' }) as Env;
  for (const appId of ['hiring', 'other']) db.sql.prepare('UPDATE app_connectors SET capabilities_json = ?, disclosure_json = ? WHERE app_id = ?').run(JSON.stringify(['calendar.read', 'meet.read']), JSON.stringify(disclosure), appId);
  requests = []; fetcher = vi.fn(provider); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('PAS Google Calendar connection and grants', () => {
  it.each(['publisher', 'disclosure'])('does not insert stale consent if the %s changes while starting', async change => {
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(query => {
      if (query.startsWith('INSERT INTO google_calendar_oauth_states')) {
        db.sql.exec(change === 'publisher'
          ? "UPDATE apps SET creator_id='gh:2' WHERE id='hiring'"
          : "UPDATE app_connectors SET contract_hash='changed' WHERE app_id='hiring'");
      }
      return prepare(query);
    });
    expect(await call({ operation: 'start', callback_path: '/callback', return_to: '/' })).toMatchObject({ error: 'connection_changed' });
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM google_calendar_oauth_states').get()!.n).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('completes both apps when their first consent flows start before either Google connection exists', async () => {
    const first = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const second = await call({ operation: 'start', callback_path: '/callback', return_to: '/' }, 'other');
    const stateB = new URL(second.authorization_url as string).searchParams.get('state')!;
    await approve(stateB);
    expect(await call({ operation: 'complete', state: first.google_url.searchParams.get('state'), code: 'first' })).toHaveProperty('email');
    expect(await call({ operation: 'complete', state: stateB, code: 'second' }, 'other')).toHaveProperty('email');
    expect(await call({ operation: 'status' })).toMatchObject({ connected: true, version: 1 });
    expect(await call({ operation: 'status' }, 'other')).toMatchObject({ connected: true, version: 1 });
  });
  it('retries only persistence when another first connection wins the shared credential CAS', async () => {
    const first = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const second = await call({ operation: 'start', callback_path: '/callback', return_to: '/' }, 'other');
    const stateB = new URL(second.authorization_url as string).searchParams.get('state')!;
    await approve(stateB);
    const batch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async statements => {
      expect(await call({ operation: 'complete', state: stateB, code: 'second' }, 'other')).toHaveProperty('email');
      return batch(statements);
    });
    expect(await call({ operation: 'complete', state: first.google_url.searchParams.get('state'), code: 'first' })).toHaveProperty('email');
    expect(requests.filter(url => url.hostname === 'oauth2.googleapis.com')).toHaveLength(2);
    expect(await call({ operation: 'status' }, 'other')).toMatchObject({ connected: true, version: 1, authorization_version: 1 });
    expect(db.sql.prepare('SELECT version,credential_revision FROM google_calendar_accounts').get()).toEqual({ version: 1, credential_revision: 2 });
  });
  it('does not mix an old authorization with account metadata changed between status queries', async () => {
    await connect();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(query => {
      if (query === 'SELECT * FROM google_calendar_accounts WHERE user_id = ?') db.sql.exec("UPDATE google_calendar_accounts SET version=version+1,status='disconnected',email=NULL");
      return prepare(query);
    });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: true, email: 'organizer@example.test', version: 1 });
  });
  it('retries consent after a concurrent refresh without exchanging the one-use code twice', async () => {
    const first = await connectApp('hiring');
    vi.setSystemTime(now + 3_600_001);
    const second = await call({ operation: 'start', callback_path: '/callback', return_to: '/' }, 'other');
    const state = new URL(second.authorization_url as string).searchParams.get('state')!;
    await approve(state);
    const batch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async statements => {
      expect(await call({ operation: 'events', grant_id: first.grant_id })).toHaveProperty('items');
      return batch(statements);
    });
    expect(await call({ operation: 'complete', state, code: 'second' }, 'other')).toHaveProperty('email');
    const exchanges = fetcher.mock.calls.filter(([url, init]) => new URL(url).hostname === 'oauth2.googleapis.com' && (init.body as URLSearchParams).get('grant_type') === 'authorization_code');
    expect(exchanges).toHaveLength(2); // One initial connection, one new consent.
    expect(db.sql.prepare('SELECT credential_revision FROM google_calendar_accounts').get()!.credential_revision).toBe(3);
    expect(await call({ operation: 'events', grant_id: first.grant_id })).toHaveProperty('items');
  });
  it('a losing same-app callback cannot replace the winner or delete its new grant', async () => {
    await connect();
    const first = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const second = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    let winnerGrant: unknown;
    const batch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async statements => {
      expect(await call({ operation: 'complete', state: second.google_url.searchParams.get('state'), code: 'winner' })).toHaveProperty('email');
      winnerGrant = (await call({ operation: 'grant', calendar_id: 'team@example.test' })).grant_id;
      return batch(statements);
    });
    expect(await call({ operation: 'complete', state: first.google_url.searchParams.get('state'), code: 'loser' })).toMatchObject({ error: 'connection_changed' });
    expect(await call({ operation: 'grant_status', grant_id: winnerGrant })).toHaveProperty('grant_id');
    expect(await call({ operation: 'status' })).toMatchObject({ authorization_version: 2 });
  });
  it('global disconnect during a consent CAS retry cannot restore credentials or app access', async () => {
    await connect();
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const batch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async statements => {
      expect(await call({ operation: 'disconnect_account', expected_version: 1 })).toEqual({ disconnected: true });
      return batch(statements);
    });
    expect(await call({ operation: 'complete', state: start.google_url.searchParams.get('state'), code: 'code' })).toMatchObject({ error: 'connection_changed' });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: false });
    expect(db.sql.prepare('SELECT status,credential_ct FROM google_calendar_accounts').get()).toEqual({ status: 'disconnected', credential_ct: null });
  });
  it('keeps parallel app consent cookies independent through both provider callbacks', async () => {
    await connect();
    const first = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const second = await call({ operation: 'start', callback_path: '/callback', return_to: '/' }, 'other');
    const stateA = new URL(first.authorization_url as string).searchParams.get('state')!;
    const stateB = new URL(second.authorization_url as string).searchParams.get('state')!;
    const a = await approve(stateA), b = await approve(stateB);
    expect(a.cookie.split('=')[0]).not.toBe(b.cookie.split('=')[0]);
    const callback = (state: string, cookie: string) => consentRouter.request(`${API}/v1/connectors/google-calendar/callback?${new URLSearchParams({ state, code: 'code' })}`, { headers: { Cookie: cookie } }, env);
    const responseA = await callback(stateA, `${a.cookie}; ${b.cookie}`);
    expect(responseA.status).toBe(302);
    expect(responseA.headers.get('Set-Cookie')).toContain(a.cookie.split('=')[0]);
    expect(responseA.headers.get('Set-Cookie')).not.toContain(b.cookie.split('=')[0]);
    expect(await call({ operation: 'complete', state: stateA, code: 'code' })).toHaveProperty('email');
    expect((await callback(stateB, b.cookie)).status).toBe(302);
    expect(await call({ operation: 'complete', state: stateB, code: 'code' }, 'other')).toHaveProperty('email');
  });
  it('uses platform configuration, PKCE and authenticated completion; credentials stay encrypted', async () => {
    expect(await call({ operation: 'status' })).toMatchObject({ configured: true, connected: false });
    const { state, url } = await connect();
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.proappstore.online/v1/connectors/google-calendar/callback');
    const exchange = fetcher.mock.calls.find(([raw]) => new URL(raw).hostname === 'oauth2.googleapis.com')![1]!;
    const form = exchange.body as URLSearchParams;
    expect(url.searchParams.get('code_challenge')).toBe(await hashState(form.get('code_verifier')!));
    const row = db.sql.prepare('SELECT * FROM google_calendar_accounts').get()!;
    expect(JSON.stringify(row)).not.toContain('private-refresh');
    expect(JSON.stringify(row)).not.toContain('private-access');
    expect(await call({ operation: 'complete', state, code: 'again' })).toMatchObject({ error: 'expired_or_used_callback' });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: true, email: 'organizer@example.test' });
  });
  it('requires a declared connector and a user for account operations; wrong users cannot consume state', async () => {
    expect(await workerGoogleCalendar(env, 'hiring', 'missing', { operation: 'status' }, actor())).toMatchObject({ error: 'connector_not_declared' });
    expect(await call({ operation: 'start' }, 'hiring', null)).toMatchObject({ error: 'user_required' });
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/settings' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    expect(await call({ operation: 'complete', state, code: 'code' }, 'hiring', actor(OTHER))).toMatchObject({ error: 'forbidden' });
    expect(await call({ operation: 'complete', state, code: 'code' }, 'other')).toMatchObject({ error: 'forbidden' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await call({ operation: 'complete', state, code: 'code' })).toHaveProperty('email');
  });
  it('rejects redirects outside the initiating app and expired state', async () => {
    for (const path of ['https://evil.test/callback', '//evil.test', '/.pas/auth/callback', '/\\evil.test']) expect(await call({ operation: 'start', callback_path: path, return_to: '/' })).toHaveProperty('error');
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    vi.setSystemTime(now + 600_001);
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'expired_or_used_callback' });
  });
  it('refuses missing configuration and partial Google consent', async () => {
    env.GOOGLE_CLIENT_SECRET = undefined;
    expect(await call({ operation: 'start' })).toMatchObject({ error: 'google_not_configured' });
    env.GOOGLE_CLIENT_SECRET = 'configured';
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    fetcher.mockResolvedValueOnce(Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', scope: 'openid email' }));
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'missing_google_permissions' });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: false });
  });
  it('never connects an unverified Google identity', async () => {
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    fetcher.mockImplementation(async (url, init) => new URL(url).pathname.endsWith('/userinfo') ? Response.json({ sub: '123456', email: 'organizer@example.test', email_verified: false }) : provider(url, init));
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'google_identity_unverified' });
  });
  it('requires app-specific OAuth before granting an exact calendar; no token leaves PAS', async () => {
    await connect();
    expect(await call({ operation: 'calendars' })).toMatchObject({ calendars: [{ id: 'team@example.test' }] });
    expect(await call({ operation: 'status' }, 'other')).toMatchObject({ connected: false, email: null });
    fetcher.mockClear();
    for (const operation of ['calendars', 'grant', 'disconnect_account']) expect(await call({ operation, calendar_id: 'team@example.test', expected_version: 1 }, 'other')).toMatchObject({ error: 'reconnect_required' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await call({ operation: 'grant', calendar_id: 'primary' })).toMatchObject({ error: 'exact_calendar_required' });
    const created = await call({ operation: 'grant', calendar_id: 'team@example.test' });
    expect(await call({ operation: 'events', grant_id: created.grant_id }, 'other')).toMatchObject({ error: 'reconnect_required' });
    const events = await call({ operation: 'events', grant_id: created.grant_id }, 'hiring', null);
    expect(events.items).toHaveLength(1);
    expect(JSON.stringify([created, events])).not.toMatch(/private-access|private-refresh/);
    expect(requests.filter(url => url.pathname.endsWith('/events'))[0].pathname).toContain('team%40example.test');
  });
  it('checks real Google calendar access before granting', async () => {
    await connect();
    fetcher.mockResolvedValueOnce(new Response('private provider body', { status: 403 }));
    expect(await call({ operation: 'grant', calendar_id: 'denied@example.test' })).toEqual({ error: 'google_forbidden', status: 502 });
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM google_calendar_grants').get()!.n).toBe(0);
  });
  it('revocation stops future reads and cannot revoke another app grant', async () => {
    const grant_id = await grant();
    expect(await call({ operation: 'revoke_grant', grant_id }, 'other')).toEqual({ revoked: false });
    expect(await call({ operation: 'revoke_grant', grant_id })).toEqual({ revoked: true });
    fetcher.mockClear();
    expect(await call({ operation: 'event', grant_id, event_id: 'event1' })).toMatchObject({ error: 'reconnect_required' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reconnecting does not silently move old grants to another Google account', async () => {
    const grant_id = await grant();
    await connect();
    expect(await call({ operation: 'grant_status', grant_id })).toMatchObject({ error: 'reconnect_required' });
  });
  it('disconnect wins a concurrent OAuth completion and erases the saved credential', async () => {
    const grant_id = await grant();
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    expect(await call({ operation: 'disconnect_account', expected_version: 1 })).toEqual({ disconnected: true });
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'expired_or_used_callback' });
    expect(await call({ operation: 'grant_status', grant_id })).toMatchObject({ error: 'reconnect_required' });
    expect(db.sql.prepare('SELECT credential_ct FROM google_calendar_accounts').get()!.credential_ct).toBeNull();
  });
  it('publisher transfer invalidates app grants and pending OAuth without deleting the user account', async () => {
    const grant_id = await grant();
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    db.sql.exec("UPDATE apps SET creator_id = 'gh:2' WHERE id = 'hiring'");
    expect(await call({ operation: 'grant_status', grant_id })).toMatchObject({ error: 'reconnect_required' });
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'expired_or_used_callback' });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: false });
    expect(db.sql.prepare('SELECT status FROM google_calendar_accounts').get()!.status).toBe('connected');
    expect(await call({ operation: 'grant', calendar_id: 'team@example.test' })).toMatchObject({ error: 'reconnect_required' });
  });
  it('disconnect during refresh cannot repersist a credential or read events', async () => {
    const grant_id = await grant();
    vi.setSystemTime(now + 3_600_001);
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).hostname === 'oauth2.googleapis.com') {
        expect(await call({ operation: 'disconnect_account', expected_version: 1 })).toEqual({ disconnected: true });
      }
      return provider(url, init);
    });
    expect(await call({ operation: 'events', grant_id })).toMatchObject({ error: 'reconnect_required' });
    expect(requests.some(url => url.pathname.endsWith('/events'))).toBe(false);
    expect(db.sql.prepare('SELECT credential_ct FROM google_calendar_accounts').get()!.credential_ct).toBeNull();
  });
  it('publisher transfer while selecting a calendar cannot create a replacement grant', async () => {
    await connect();
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).pathname.includes('/calendarList/')) db.sql.exec("UPDATE apps SET creator_id = 'gh:2' WHERE id = 'hiring'");
      return provider(url, init);
    });
    expect(await call({ operation: 'grant', calendar_id: 'team@example.test' })).toMatchObject({ error: 'connection_changed' });
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM google_calendar_grants').get()!.n).toBe(0);
  });
  it('publisher transfer during the token exchange cannot authorize the new publisher', async () => {
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).pathname.endsWith('/userinfo')) db.sql.exec("UPDATE apps SET creator_id = 'gh:2' WHERE id = 'hiring'");
      return provider(url, init);
    });
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'connection_changed' });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: false });
    expect(await call({ operation: 'grant', calendar_id: 'team@example.test' })).toMatchObject({ error: 'reconnect_required' });
  });
  it('refreshes an expired access token internally and sanitizes provider errors', async () => {
    const grant_id = await grant();
    vi.setSystemTime(now + 3_600_001);
    expect(await call({ operation: 'events', grant_id })).toHaveProperty('items');
    expect(requests.filter(url => url.hostname === 'oauth2.googleapis.com')).toHaveLength(2);
    fetcher.mockResolvedValueOnce(new Response('secret provider diagnostic', { status: 429 }));
    expect(await call({ operation: 'event', grant_id, event_id: 'event1' })).toEqual({ error: 'google_rate_limited', status: 502 });
  });
  it('account deletion stops scheduled access and pending consent only for the deleted app/user', async () => {
    const grant_id = await grant();
    // Model a second app the user already authorized at this account version.
    db.sql.exec(`INSERT INTO google_calendar_app_authorizations (app_id,user_id,account_version) VALUES ('other','gh:1',1)`);
    const other = await call({ operation: 'grant', calendar_id: 'team@example.test' }, 'other');
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    const credential = db.sql.prepare('SELECT * FROM google_calendar_accounts').get();
    await deleteAppAccount();
    fetcher.mockClear();
    expect(await call({ operation: 'events', grant_id }, 'hiring', null)).toMatchObject({ error: 'reconnect_required' });
    expect(await call({ operation: 'complete', state, code: 'late-code' })).toMatchObject({ error: 'expired_or_used_callback' });
    expect(await call({ operation: 'start', callback_path: '/callback', return_to: '/' })).toMatchObject({ error: 'app_account_deleted', status: 403 });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: false, email: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.sql.prepare('SELECT * FROM google_calendar_accounts').get()).toEqual(credential);
    expect(await call({ operation: 'events', grant_id: other.grant_id }, 'other', null)).toHaveProperty('items');
    await deleteAppAccount();
  });
  it('account deletion during an OAuth exchange cannot replace the shared credential or reauthorize', async () => {
    await grant();
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    const credential = db.sql.prepare('SELECT * FROM google_calendar_accounts').get();
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).pathname.endsWith('/userinfo')) await deleteAppAccount();
      return provider(url, init);
    });
    expect(await call({ operation: 'complete', state, code: 'late-code' })).toMatchObject({ error: 'connection_changed' });
    expect(db.sql.prepare('SELECT * FROM google_calendar_accounts').get()).toEqual(credential);
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM google_calendar_app_authorizations WHERE app_id='hiring'").get()!.n).toBe(0);
  });
  it('deletion during token refresh prevents the next provider read', async () => {
    const grant_id = await grant();
    vi.setSystemTime(now + 3_600_001);
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).hostname === 'oauth2.googleapis.com') await deleteAppAccount();
      return provider(url, init);
    });
    expect(await call({ operation: 'events', grant_id }, 'hiring', null)).toMatchObject({ error: 'reconnect_required' });
    expect(requests.some(url => url.pathname.endsWith('/events'))).toBe(false);
  });
  it('a concurrent account version change cannot authorize an exchange whose credential write lost', async () => {
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).pathname.endsWith('/userinfo')) db.sql.exec('UPDATE google_calendar_accounts SET version = version + 1');
      return provider(url, init);
    });
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'connection_changed' });
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM google_calendar_app_authorizations').get()!.n).toBe(0);
  });
  it.each(['events', 'calendars'])('discards %s data if deletion wins during the provider read', async operation => {
    const grant_id = await grant();
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).pathname.endsWith(operation === 'events' ? '/events' : '/calendarList')) await deleteAppAccount();
      return provider(url, init);
    });
    expect(await call({ operation, grant_id })).toMatchObject({ error: 'reconnect_required' });
  });
  it('refuses stale grants when an app-account deletion marker already exists', async () => {
    const grant_id = await grant();
    db.sql.prepare('INSERT INTO per_app_deleted_users (app_id,user_id,deleted_by,deleted_at) VALUES (?,?,?,?)').run('hiring', USER, USER, now);
    fetcher.mockClear();
    expect(await call({ operation: 'events', grant_id }, 'hiring', null)).toMatchObject({ error: 'reconnect_required' });
    expect(await call({ operation: 'calendars' })).toMatchObject({ error: 'reconnect_required' });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not start a Meet read after deletion during the preceding event lookup', async () => {
    const grant_id = await grant();
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).pathname.endsWith('/events/event1')) await deleteAppAccount();
      return provider(url, init);
    });
    expect(await call({ operation: 'conferences', grant_id, event_id: 'event1', meeting_code: 'abc-defg-hij', starts_at: now - 7_200_000, ends_at: now - 3_600_000 }, 'hiring', null)).toMatchObject({ error: 'reconnect_required' });
    expect(requests.some(url => url.hostname === 'meet.googleapis.com')).toBe(false);
  });
});

describe('Meet reads are restricted to an exact granted event', () => {
  it('requires a real event, matching timing/code, then signed parent receipts', async () => {
    const grant_id = await grant();
    const query = { operation: 'conferences', grant_id, event_id: 'event1', starts_at: now - 7_200_000, ends_at: now - 3_600_000, meeting_code: 'abc-defg-hij' };
    expect(await call({ ...query, meeting_code: 'xxx-yyyy-zzz' })).toMatchObject({ error: 'meeting_changed' });
    const records = await call(query) as any;
    expect(requests.find(url => url.hostname === 'meet.googleapis.com')!.searchParams.get('filter')).toContain('space.meeting_code = "abc-defg-hij"');
    const record = records.conferenceRecords[0];
    expect(await call({ operation: 'participants', grant_id, resource: record.name })).toMatchObject({ error: 'invalid_resource_receipt' });
    const participants = await call({ operation: 'participants', grant_id, resource: record.name, receipt: record.receipt }) as any;
    expect(participants.participants[0].signedinUser).toEqual({ user: 'users/123456', displayName: 'Private name' });
    expect(participants.participants[1].anonymousUser).toEqual({ displayName: 'Private guest' });
    const person = participants.participants[0];
    const sessions = await call({ operation: 'sessions', grant_id, resource: person.name, receipt: person.receipt }) as any;
    expect(sessions.participantSessions).toHaveLength(1);
    expect(await call({ operation: 'sessions', grant_id, resource: person.name.replace('person1', 'other'), receipt: person.receipt })).toMatchObject({ error: 'invalid_resource_receipt' });
  });
  it('lists exact series instances with bounded backfill and pagination', async () => {
    const grant_id = await grant();
    fetcher.mockImplementation(async (url, init) => new URL(url).pathname.endsWith('/instances')
      ? Response.json({ items: [{ ...meeting(), recurringEventId: 'series1' }], nextPageToken: 'page2' }) : provider(url, init));
    const query = { operation: 'instances', grant_id, event_id: 'series1', starts_at: now - 14 * 86_400_000, ends_at: now, page_token: 'page1' };
    expect(await call(query)).toMatchObject({ items: [{ recurringEventId: 'series1' }], nextPageToken: 'page2' });
    const url = new URL(fetcher.mock.calls.at(-1)![0]);
    expect(url.pathname).toBe('/calendar/v3/calendars/team%40example.test/events/series1/instances');
    expect(url.searchParams.get('pageToken')).toBe('page1');
    expect(url.searchParams.get('timeMin')).toBe(new Date(query.starts_at).toISOString());
    for (const range of [{ starts_at: now - 29 * 86_400_000 }, { ends_at: now + 31 * 86_400_000 }, { ends_at: query.starts_at }, { starts_at: NaN }]) {
      fetcher.mockClear();
      expect(await call({ ...query, ...range })).toMatchObject({ error: 'invalid_meeting_window' });
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(await call(query, 'other')).toMatchObject({ error: 'reconnect_required' });
  });
  it('allows last-week Meet evidence but refuses expired or future meetings', async () => {
    const grant_id = await grant();
    for (const days of [14, 29, -1]) {
      const starts_at = now - days * 86_400_000, ends_at = starts_at + 3_600_000;
      fetcher.mockImplementation(async (url, init) => new URL(url).pathname.endsWith('/events/event1')
        ? Response.json({ ...meeting(), start: { dateTime: new Date(starts_at).toISOString() }, end: { dateTime: new Date(ends_at).toISOString() } }) : provider(url, init));
      const result = await call({ operation: 'conferences', grant_id, event_id: 'event1', starts_at, ends_at, meeting_code: 'abc-defg-hij' });
      if (days === 14) expect(result).toHaveProperty('conferenceRecords');
      else expect(result).toMatchObject({ error: 'invalid_meeting_window' });
    }
  });
  it('receipts cannot be moved between grants, forged, or retained after expiry', async () => {
    const receipt = await resourceReceipt(env, 'grant-one', 'conferenceRecords/one');
    await expect(verifyResourceReceipt(env, receipt, 'grant-one', 'conferenceRecords/one')).resolves.toBeUndefined();
    for (const [value, grant, resource] of [[receipt, 'grant-two', 'conferenceRecords/one'], [receipt, 'grant-one', 'conferenceRecords/two'], [receipt + 'x', 'grant-one', 'conferenceRecords/one']]) await expect(verifyResourceReceipt(env, value, grant, resource)).rejects.toThrow('invalid_resource_receipt');
    vi.setSystemTime(now + 300_001);
    await expect(verifyResourceReceipt(env, receipt, 'grant-one', 'conferenceRecords/one')).rejects.toThrow('invalid_resource_receipt');
  });
  it('keeps Google requests bounded and refuses redirects and malformed/oversized responses', async () => {
    fetcher.mockResolvedValueOnce(Response.json([]));
    await expect(googleJson('https://www.googleapis.com/test')).rejects.toThrow('google_invalid_response');
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(1_048_577)));
    await expect(googleJson('https://www.googleapis.com/test')).rejects.toThrow('google_invalid_response');
    fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }));
    await expect(googleJson('https://www.googleapis.com/test')).rejects.toThrow('google_unavailable');
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'manual' && init.signal)).toBe(true);
  });
});

it('callback forwards only code/state to the pinned app; completion still requires its user', async () => {
  const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/settings' });
  const state = new URL(start.authorization_url as string).searchParams.get('state')!;
  const router = new Hono<{ Bindings: Env }>().route('/v1', googleCalendarRoutes);
  const response = await router.request(`/v1/connectors/google-calendar/callback?${new URLSearchParams({ code: 'one-use-code', state })}`, { headers: { Cookie: start.cookie } }, env);
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe(`https://hiring.proappstore.online/callback?code=one-use-code&state=${state}`);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(fetcher).not.toHaveBeenCalled();
  expect((await router.request('/v1/connectors/google-calendar/callback?state=invalid', {}, env)).status).toBe(400);
});

async function connectApp(appId: string, capabilities = ['calendar.read', 'meet.read']) {
  const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/', capabilities }, appId);
  expect(start).toHaveProperty('authorization_url');
  const state = new URL(start.authorization_url as string).searchParams.get('state')!;
  const accepted = await approve(state, capabilities);
  expect(await call({ operation: 'complete', state, code: 'code' }, appId)).toHaveProperty('email');
  const grant = await call({ operation: 'grant', calendar_id: 'team@example.test' }, appId);
  expect(grant).toHaveProperty('grant_id');
  return { state, grant_id: grant.grant_id as string, ...accepted };
}
describe('independent app capabilities and consent (#539)', () => {
  it('connecting and reconnecting a second app preserves the first app and its pending consent', async () => {
    const first = await connectApp('hiring');
    const second = await connectApp('other');
    expect(await call({ operation: 'events', grant_id: first.grant_id }, 'hiring', null)).toHaveProperty('items');
    const pending = await call({ operation: 'start', callback_path: '/callback', return_to: '/' }, 'hiring');
    const state = new URL(pending.authorization_url as string).searchParams.get('state')!;
    await approve(state);
    await connectApp('other');
    expect(await call({ operation: 'grant_status', grant_id: second.grant_id }, 'other')).toMatchObject({ error: 'reconnect_required' });
    expect(await call({ operation: 'grant_status', grant_id: first.grant_id })).toHaveProperty('grant_id');
    expect(await call({ operation: 'complete', state, code: 'code' })).toHaveProperty('email');
    expect((await call({ operation: 'status' }, 'other')).authorization_version).toBe(2);
    expect(db.sql.prepare('SELECT version FROM google_calendar_accounts').get()!.version).toBe(1);
  });
  it('requests Calendar only when selected and never transfers another app\'s Meet permission', async () => {
    fetcher.mockImplementation(async (url, init) => new URL(url).hostname === 'oauth2.googleapis.com'
      ? Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.filter(s => !s.includes('meetings')).join(' ') }) : provider(url, init));
    const first = await connectApp('hiring', ['calendar.read']);
    expect(first.url.searchParams.get('scope')).not.toContain('meetings.space');
    expect(first.url.searchParams.get('include_granted_scopes')).toBe('true');
    fetcher.mockImplementation(provider);
    const second = await connectApp('other');
    expect(await call({ operation: 'conferences', grant_id: first.grant_id })).toMatchObject({ error: 'capability_not_granted', status: 403 });
    expect(await call({ operation: 'events', grant_id: first.grant_id })).toHaveProperty('items');
    expect(await call({ operation: 'status' })).toMatchObject({ capabilities: ['calendar.read'], consent_version: 2, consented_at: now });
    expect(await call({ operation: 'grant_status', grant_id: second.grant_id }, 'other')).toHaveProperty('grant_id');
  });
  it('refuses identity substitution and scope reduction without replacing the shared credential', async () => {
    const first = await connectApp('hiring');
    const before = db.sql.prepare('SELECT * FROM google_calendar_accounts').get();
    const begin = async () => {
      const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/', capabilities: ['calendar.read'] }, 'other');
      const state = new URL(start.authorization_url as string).searchParams.get('state')!;
      await approve(state, ['calendar.read']); return state;
    };
    const mismatch = await begin();
    fetcher.mockImplementation(async (url, init) => new URL(url).pathname.endsWith('/userinfo') ? Response.json({ sub: '999999', email: 'another@example.test', email_verified: true }) : provider(url, init));
    expect(await call({ operation: 'complete', state: mismatch, code: 'code' }, 'other')).toMatchObject({ error: 'google_account_mismatch' });
    expect(db.sql.prepare('SELECT * FROM google_calendar_accounts').get()).toEqual(before);
    const reduced = await begin();
    fetcher.mockImplementation(async (url, init) => new URL(url).hostname === 'oauth2.googleapis.com'
      ? Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.filter(s => !s.includes('meetings')).join(' ') }) : provider(url, init));
    expect(await call({ operation: 'complete', state: reduced, code: 'code' }, 'other')).toMatchObject({ error: 'missing_google_permissions' });
    expect(db.sql.prepare('SELECT * FROM google_calendar_accounts').get()).toEqual(before);
    expect(await call({ operation: 'events', grant_id: first.grant_id })).toHaveProperty('items');
  });
  it('a per-app disconnect preserves another app; global disconnect removes every app grant and pending request', async () => {
    const first = await connectApp('hiring'), second = await connectApp('other');
    expect(await call({ operation: 'disconnect_app', expected_version: 0 }, 'other')).toMatchObject({ error: 'connection_changed' });
    expect(await call({ operation: 'disconnect_app', expected_version: 1 }, 'other')).toEqual({ disconnected: true });
    expect(await call({ operation: 'events', grant_id: first.grant_id })).toHaveProperty('items');
    expect(await call({ operation: 'grant_status', grant_id: second.grant_id }, 'other')).toMatchObject({ error: 'reconnect_required' });
    await call({ operation: 'start', callback_path: '/callback', return_to: '/' }, 'other');
    expect(await call({ operation: 'disconnect_account', expected_version: 1 })).toEqual({ disconnected: true });
    for (const table of ['google_calendar_app_authorizations', 'google_calendar_grants', 'google_calendar_oauth_states']) expect(db.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
  });
  it('an old refresh cannot overwrite a second app\'s newer consent and scope upgrade', async () => {
    fetcher.mockImplementation(async (url, init) => new URL(url).hostname === 'oauth2.googleapis.com'
      ? Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.filter(s => !s.includes('meetings')).join(' ') }) : provider(url, init));
    const first = await connectApp('hiring', ['calendar.read']);
    vi.setSystemTime(now + 3_600_001);
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' }, 'other');
    const state = new URL(start.authorization_url as string).searchParams.get('state')!; await approve(state);
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(url).hostname === 'oauth2.googleapis.com' && (init?.body as URLSearchParams).get('grant_type') === 'refresh_token') {
        expect(await call({ operation: 'complete', state, code: 'code' }, 'other')).toHaveProperty('email');
        return Response.json({ access_token: 'stale-access', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.filter(s => !s.includes('meetings')).join(' ') });
      }
      return provider(url, init);
    });
    expect(await call({ operation: 'events', grant_id: first.grant_id })).toHaveProperty('items');
    const row = db.sql.prepare('SELECT credential_revision, scopes_json FROM google_calendar_accounts').get()!;
    expect(row.credential_revision).toBe(2);
    expect(row.scopes_json).toContain('meetings.space.readonly');
    expect(await call({ operation: 'status' }, 'other')).toMatchObject({ connected: true, capabilities: ['calendar.read', 'meet.read'] });
  });
  it('GET and direct completion cannot bypass personally approved platform consent', async () => {
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const url = new URL(start.authorization_url as string), state = url.searchParams.get('state')!;
    expect(url.origin).toBe(API);
    const page = await consentRouter.request(url.href, {}, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('First, confirm');
    expect(db.sql.prepare('SELECT consented_at FROM google_calendar_oauth_states').get()!.consented_at).toBeNull();
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'platform_consent_required' });
    expect((await consentRouter.request(`${API}/v1/connectors/google-calendar/callback?${new URLSearchParams({ state, code: 'code' })}`, {}, env)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cannot reuse an approved legacy browser binding as first-party authentication proof', async () => {
    const start = await approvedStart({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = start.google_url.searchParams.get('state')!;
    db.sql.exec('UPDATE google_calendar_oauth_states SET browser_verified_at=NULL');
    expect((await consentRouter.request(`${API}${consentUrlForTest(state)}`, { headers: { Cookie: start.cookie } }, env)).status).toBe(400);
    expect((await consentRouter.request(`${API}/v1/connectors/google-calendar/callback?${new URLSearchParams({ state, code: 'code' })}`, { headers: { Cookie: start.cookie } }, env)).status).toBe(400);
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'platform_consent_required' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses app-bound, workload and unproven credentials on both consent sign-in paths', async () => {
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state')!;
    const credentials = [
      {},
      { cred: credentialContext('app_bound', 'hiring') },
      { cred: credentialContext('workload_session') },
      { cred: { v: 2, kind: 'first_party_session' } },
      { cred: credentialContext('first_party_session'), via: 'oidc-e2e' },
    ];
    for (const [index, context] of credentials.entries()) {
      const claims = { uid: USER, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', ...context };
      const token = await mintSession(claims, env.SESSION_SIGNING_KEY);
      const post = await consentRouter.request(`${API}/v1/connectors/google-calendar/session?state=${state}`, { method: 'POST', headers: { Origin: API, Authorization: `Bearer ${token}` } }, env);
      expect(post.status).toBe(403);
      expect(post.headers.get('Set-Cookie')).toBeNull();
      const code = `untrusted-context-${index}`;
      db.sql.prepare('INSERT INTO auth_exchange_codes (code_hash,claims,expires_at,created_at) VALUES (?,?,?,?)').run(await hashState(code), JSON.stringify(claims), now + 60_000, now);
      const get = await consentRouter.request(`${API}/v1/connectors/google-calendar/session?${new URLSearchParams({ state, code })}`, {}, env);
      expect(get.status).toBe(400);
      expect(get.headers.get('Set-Cookie')).toBeNull();
    }
    expect(db.sql.prepare('SELECT browser_hash,consented_at FROM google_calendar_oauth_states').get()).toEqual({ browser_hash: null, consented_at: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires the initiating identity, a fresh interactive login, correct origin, browser and CSRF', async () => {
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/', capabilities: ['calendar.read'] });
    const state = new URL(start.authorization_url as string).searchParams.get('state')!;
    const token = (uid: string, authTime = Math.floor(Date.now() / 1000)) => mintSession({ uid, roles: ['user'], auth_time: authTime, auth_method: 'github', cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
    const session = (jwt: string, origin = API) => consentRouter.request(`${API}/v1/connectors/google-calendar/session?state=${state}`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${jwt}` } }, env);
    expect((await session(await token(OTHER))).status).toBe(403);
    expect((await session(await token(USER, Math.floor(Date.now() / 1000) - 301))).status).toBe(403);
    expect((await session(await token(USER), 'https://hiring.proappstore.online')).status).toBe(403);
    const bound = await session(await token(USER)), cookie = bound.headers.get('Set-Cookie')!.split(';')[0]!;
    const content = await (await consentRouter.request(`${API}${consentUrlForTest(state)}`, { headers: { Cookie: cookie } }, env)).text();
    const csrf = content.match(/name="csrf" value="([^"]+)"/)![1]!;
    const submit = (proof: string, browser = cookie, origin = API, capability = 'calendar.read') => {
      const body = new FormData(); body.set('csrf', proof); body.set('decision', 'allow'); body.append('capability', 'calendar.read'); if (capability !== 'calendar.read') body.append('capability', capability);
      return consentRouter.request(`${API}${consentUrlForTest(state)}`, { method: 'POST', headers: { Origin: origin, Cookie: browser }, body }, env);
    };
    expect((await submit('forged')).status).toBe(400);
    expect((await submit(csrf, '')).status).toBe(400);
    expect((await submit(csrf, cookie, 'https://other.proappstore.online')).status).toBe(400);
    expect((await submit(csrf, cookie, API, 'meet.read')).status).toBe(400);
    expect((await submit(csrf)).status).toBe(302);
    expect((await submit(csrf)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('redeems OAuth sign-in only for the initiating PAS identity and keeps the session out of app URLs', async () => {
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state')!;
    const code = 'one-time-pas-login';
    db.sql.prepare('INSERT INTO auth_exchange_codes (code_hash,claims,expires_at,created_at) VALUES (?,?,?,?)').run(await hashState(code), JSON.stringify({ uid: USER, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', cred: credentialContext('first_party_session') }), now + 60_000, now);
    const response = await consentRouter.request(`${API}/v1/connectors/google-calendar/session?${new URLSearchParams({ state, code })}`, {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(consentUrlForTest(state));
    expect(response.headers.get('Location')).not.toContain('code=');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('__Host-');
    expect((await consentRouter.request(`${API}/v1/connectors/google-calendar/session?${new URLSearchParams({ state, code })}`, {}, env)).status).toBe(400);
  });
  it('contract changes revoke only the changed app and cannot resurrect old grants on rollback', async () => {
    const first = await connectApp('hiring'), second = await connectApp('other');
    const pending = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(pending.authorization_url as string).searchParams.get('state')!;
    db.sql.exec("UPDATE app_connectors SET contract_hash = 'updated' WHERE app_id='hiring'");
    db.sql.exec("UPDATE app_connectors SET contract_hash = 'legacy' WHERE app_id='hiring'");
    expect(await call({ operation: 'grant_status', grant_id: first.grant_id })).toMatchObject({ error: 'reconnect_required' });
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'expired_or_used_callback' });
    expect(await call({ operation: 'events', grant_id: second.grant_id }, 'other')).toHaveProperty('items');
  });
});
const consentUrlForTest = (state: string) => `/v1/connectors/google-calendar/consent?state=${state}`;

it('registration requires disclosures for new Google apps, defaults to Calendar and preserves unchanged deployments', async () => {
  db.sql.exec("DELETE FROM app_connectors WHERE app_id='hiring'");
  const bare = { name: 'calendar', kind: 'google_calendar', modes: ['oauth'] };
  expect((await replaceAppTools(db, 'hiring', [], env, { connectors: [bare] })).status).toBe(400);
  expect((await replaceAppTools(db, 'hiring', [], env, { connectors: [{ ...bare, disclosure }] })).status).toBe(200);
  const policy = db.sql.prepare("SELECT * FROM app_connectors WHERE app_id='hiring'").get()!;
  expect(policy.capabilities_json).toBe('["calendar.read"]');
  // Golden from the version-1 publisher contract; stronger sign-in proof must
  // not revoke users simply because their publisher deploys unchanged fields.
  expect(policy.contract_hash).toBe('6qTJswfNioX7rpOgxr-8ed8eMoRmEDQXEn-v34wAjjY');
  const connected = await connectApp('hiring', ['calendar.read']);
  expect((await replaceAppTools(db, 'hiring', [], env, { connectors: [{ ...bare, disclosure }] })).status).toBe(200);
  expect(await call({ operation: 'grant_status', grant_id: connected.grant_id })).toHaveProperty('grant_id');
  expect((await replaceAppTools(db, 'hiring', [], env, { connectors: [bare] })).status).toBe(200);
  expect(db.sql.prepare("SELECT contract_hash FROM app_connectors WHERE app_id='hiring'").get()!.contract_hash).toBe(policy.contract_hash);
  expect(await call({ operation: 'grant_status', grant_id: connected.grant_id })).toHaveProperty('grant_id');
  await replaceAppTools(db, 'hiring', [], env, { connectors: [{ ...bare, disclosure: { ...disclosure, audience: 'Only explicitly selected project members see records.' } }] });
  expect(await call({ operation: 'grant_status', grant_id: connected.grant_id })).toMatchObject({ error: 'reconnect_required' });
});

it('escapes publisher disclosures and cancellation destroys the pending request without calling Google', async () => {
  const unsafe = { ...disclosure, purpose: '<script>window.publisherInjected = true</script> Meeting records.' };
  db.sql.prepare("UPDATE app_connectors SET disclosure_json=? WHERE app_id='hiring'").run(JSON.stringify(unsafe));
  const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
  const state = new URL(start.authorization_url as string).searchParams.get('state')!;
  const token = await mintSession({ uid: USER, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  const session = await consentRouter.request(`${API}/v1/connectors/google-calendar/session?state=${state}`, { method: 'POST', headers: { Origin: API, Authorization: `Bearer ${token}` } }, env);
  const cookie = session.headers.get('Set-Cookie')!.split(';')[0]!;
  const page = await consentRouter.request(`${API}${consentUrlForTest(state)}`, { headers: { Cookie: cookie } }, env), content = await page.text();
  expect(content).toContain('&lt;script&gt;');
  expect(content).not.toContain('<script>window.publisherInjected');
  expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
  const body = new FormData(); body.set('decision', 'deny'); body.set('csrf', content.match(/name="csrf" value="([^"]+)"/)![1]!);
  const cancelled = await consentRouter.request(`${API}${consentUrlForTest(state)}`, { method: 'POST', headers: { Origin: API, Cookie: cookie }, body }, env);
  expect(cancelled.status).toBe(302);
  expect(cancelled.headers.get('Location')).toBe(`https://hiring.proappstore.online/callback?error=google_cancelled&state=${state}`);
  expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'expired_or_used_callback' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('the platform global-disconnect control requires explicit confirmation and cannot be replayed', async () => {
  await connectApp('hiring'); await connectApp('other');
  const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
  const state = new URL(start.authorization_url as string).searchParams.get('state')!;
  const token = await mintSession({ uid: USER, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github', cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  const session = await consentRouter.request(`${API}/v1/connectors/google-calendar/session?state=${state}`, { method: 'POST', headers: { Origin: API, Authorization: `Bearer ${token}` } }, env);
  const cookie = session.headers.get('Set-Cookie')!.split(';')[0]!;
  const content = await (await consentRouter.request(`${API}${consentUrlForTest(state)}`, { headers: { Cookie: cookie } }, env)).text();
  expect(content).toContain('Disconnect Google for all of my apps');
  const body = new FormData(); body.set('decision', 'disconnect_all'); body.set('expected_version', '1'); body.set('csrf', content.match(/name="csrf" value="([^"]+)"/)![1]!);
  const submit = () => consentRouter.request(`${API}${consentUrlForTest(state)}`, { method: 'POST', headers: { Origin: API, Cookie: cookie }, body }, env);
  expect((await submit()).status).toBe(400);
  expect(await call({ operation: 'status' }, 'other')).toMatchObject({ connected: true });
  body.set('confirm_global', 'yes');
  expect((await submit()).status).toBe(200);
  expect(await call({ operation: 'status' }, 'other')).toMatchObject({ connected: false });
  expect((await submit()).status).toBe(400);
});
