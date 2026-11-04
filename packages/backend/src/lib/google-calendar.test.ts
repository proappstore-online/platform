import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { workerGoogleCalendar } from './google-calendar-worker.js';
import { GOOGLE_CALENDAR_SCOPES, googleJson, hashState, resourceReceipt, verifyResourceReceipt } from './google-calendar-common.js';
import { googleCalendarRoutes } from '../routes/google-calendar.js';
import { Hono } from 'hono';

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
async function connect() {
  const start = await call({ operation: 'start', callback_path: '/recruiter/google-calendar/callback', return_to: '/recruiter/settings' });
  const url = new URL(start.authorization_url as string), state = url.searchParams.get('state')!;
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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:1','github','1','owner',0,0),('gh:2','github','2','other',0,0);
    INSERT INTO apps (id,creator_id,created_at) VALUES ('hiring','gh:1',0),('other','gh:2',0);
    INSERT INTO app_connectors (app_id,name,kind,modes,events,created_at) VALUES ('hiring','calendar','google_calendar','["oauth"]','[]',0),('other','calendar','google_calendar','["oauth"]','[]',0);`);
  env = makeEnv({ DB: db, APP_SECRET_KEK: KEK, GOOGLE_CLIENT_ID: 'platform-google-id', GOOGLE_CLIENT_SECRET: 'platform-google-secret' }) as Env;
  requests = []; fetcher = vi.fn(provider); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('PAS Google Calendar connection and grants', () => {
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
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/settings' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    expect(await call({ operation: 'complete', state, code: 'code' }, 'hiring', actor(OTHER))).toMatchObject({ error: 'forbidden' });
    expect(await call({ operation: 'complete', state, code: 'code' }, 'other')).toMatchObject({ error: 'forbidden' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await call({ operation: 'complete', state, code: 'code' })).toHaveProperty('email');
  });
  it('rejects redirects outside the initiating app and expired state', async () => {
    for (const path of ['https://evil.test/callback', '//evil.test', '/.pas/auth/callback', '/\\evil.test']) expect(await call({ operation: 'start', callback_path: path, return_to: '/' })).toHaveProperty('error');
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    vi.setSystemTime(now + 600_001);
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'expired_or_used_callback' });
  });
  it('refuses missing configuration and partial Google consent', async () => {
    env.GOOGLE_CLIENT_SECRET = undefined;
    expect(await call({ operation: 'start' })).toMatchObject({ error: 'google_not_configured' });
    env.GOOGLE_CLIENT_SECRET = 'configured';
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    fetcher.mockResolvedValueOnce(Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', scope: 'openid email' }));
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'missing_google_permissions' });
    expect(await call({ operation: 'status' })).toMatchObject({ connected: false });
  });
  it('never connects an unverified Google identity', async () => {
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
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
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
    const state = new URL(start.authorization_url as string).searchParams.get('state');
    expect(await call({ operation: 'disconnect_account', expected_version: 1 })).toEqual({ disconnected: true });
    expect(await call({ operation: 'complete', state, code: 'code' })).toMatchObject({ error: 'connection_changed' });
    expect(await call({ operation: 'grant_status', grant_id })).toMatchObject({ error: 'reconnect_required' });
    expect(db.sql.prepare('SELECT credential_ct FROM google_calendar_accounts').get()!.credential_ct).toBeNull();
  });
  it('publisher transfer invalidates app grants and pending OAuth without deleting the user account', async () => {
    const grant_id = await grant();
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
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
    expect(await call({ operation: 'events', grant_id })).toMatchObject({ error: 'connection_changed' });
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
    const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/' });
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
    expect(JSON.stringify(participants)).not.toContain('Private');
    const person = participants.participants[0];
    const sessions = await call({ operation: 'sessions', grant_id, resource: person.name, receipt: person.receipt }) as any;
    expect(sessions.participantSessions).toHaveLength(1);
    expect(await call({ operation: 'sessions', grant_id, resource: person.name.replace('person1', 'other'), receipt: person.receipt })).toMatchObject({ error: 'invalid_resource_receipt' });
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
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error' && init.signal)).toBe(true);
  });
});

it('callback forwards only code/state to the pinned app; completion still requires its user', async () => {
  const start = await call({ operation: 'start', callback_path: '/callback', return_to: '/settings' });
  const state = new URL(start.authorization_url as string).searchParams.get('state')!;
  const router = new Hono<{ Bindings: Env }>().route('/v1', googleCalendarRoutes);
  const response = await router.request(`/v1/connectors/google-calendar/callback?${new URLSearchParams({ code: 'one-use-code', state })}`, {}, env);
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe(`https://hiring.proappstore.online/callback?code=one-use-code&state=${state}`);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(fetcher).not.toHaveBeenCalled();
  expect((await router.request('/v1/connectors/google-calendar/callback?state=invalid', {}, env)).status).toBe(400);
});
