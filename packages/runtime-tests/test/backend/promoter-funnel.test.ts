import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { handleAuthRoute, SESSION_COOKIE_NAME } from '../../../host/src/auth-handler';
import { handlePlatformMediation } from '../../../host/src/platform-mediation';
import type { Env as HostEnv } from '../../../host/src/env';
import { seedReferralReady } from '../../../backend/src/promoter-test-helpers';
import { BASE, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

// Owner-authorized API fallback for #555. Real workerd/D1, SDK capture, host
// callback and mediation; no browser, Console/Storefront rendering or QR claim.
// This suite never inserts attribution/activation rows or calls recordActivation.
const SDK = '../../../sdk/src/';
type Claim = { credited: boolean; state: string };
type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
type Auth = { token: null; usesPlatformCookie: boolean; isSignedIn: boolean;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response> };
const { Referrals } = await import(/* @vite-ignore */ `${SDK}referrals`) as {
  Referrals: new (app: string, api: string, auth: Auth, storage: Storage) => {
    capture(href: string): string | null; pending(): { code: string } | null; claim(): Promise<Claim | null>;
  };
};
const OWNER = 'gh:funnel-owner', PROMOTER = 'gh:funnel-promoter';
const REFEREE = 'gh:funnel-referee', ORGANIC = 'gh:funnel-organic';
const hostEnv = { API: (env as unknown as { HOST_API: Fetcher }).HOST_API } as HostEnv;
const route = (slug = 'funnel') => ({ slug, zone: 'proappstore.online', r2_prefix: `apps/${slug}/`, store: 'pas' });
const origin = 'https://funnel.proappstore.online';
type Enrollment = { promoter: { promoter_id: string; code: string; share_url: string } };
type Promotion = { counts: { confirmed: number; pending: number }; share_of_referred_users: { numerator: number; denominator: number; percent: number } };
type Contributors = { contributors: { display_name: string; contributions: { promotion: { confirmed_referrals: number } } }[] };

async function person(method: string, path: string, uid = PROMOTER, body?: unknown) {
  const token = await mintSession({ uid, roles: ['user'], auth_method: 'google',
    auth_time: Math.floor(Date.now() / 1000), cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  return SELF.fetch(`${BASE}/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function parsed<T>(response: Response): Promise<T> {
  expect(response.status).toBeLessThan(300);
  return response.json<T>();
}
const mine = async () => (await parsed<{ contributions: { promotion: Promotion } }>(
  await person('GET', '/apps/funnel/promoters/me/contributions'))).contributions.promotion;
const contributors = async () => parsed<Contributors>(await SELF.fetch(`${BASE}/v1/storefront/apps/funnel/contributors`));
const enroll = async (app = 'funnel') => parsed<Enrollment>(await person('POST', `/apps/${app}/promoters/enroll`, PROMOTER, { consent: true }));

/** Independent HTTP identity and local storage, surviving SDK reconstruction. */
function client(uid: string, app = 'funnel') {
  const values = new Map<string, string>();
  const storage: Storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); } };
  let cookie = '';
  const clientOrigin = `https://${app}.proappstore.online`;
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', clientOrigin);
    if (cookie) headers.set('Cookie', cookie);
    const response = await handlePlatformMediation(new Request(`${clientOrigin}/.pas/api${path}`, { ...init, headers }),
      hostEnv, route(app), createExecutionContext());
    if (!response) throw new Error('The real host did not mediate this API path');
    return response;
  };
  const auth: Auth = { token: null, usesPlatformCookie: true, isSignedIn: false,
    authenticatedFetch: (input, init) => send(new URL(String(input)).pathname, init) };
  const sdk = () => new Referrals(app, BASE, auth, storage);
  const start = async (returnPath: string) => {
    const response = await handleAuthRoute(new Request(`${clientOrigin}/.pas/auth/start?provider=google&return_to=${encodeURIComponent(returnPath)}`), hostEnv, route(app));
    expect(response?.status).toBe(302);
    // Inspect the handoff only; never follow it to a provider or production API.
    const upstream = new URL(response!.headers.get('Location')!);
    expect(upstream.searchParams.get('app_id')).toBe(app);
    return { callback: new URL(upstream.searchParams.get('return_to')!), nonceCookie: response!.headers.get('Set-Cookie')!.split(';')[0] };
  };
  const login = async (returnPath: string) => {
    const started = await start(returnPath);
    // Synthetic provider boundary only: insert a short-lived one-time code, not
    // a session/attribution/activation. Real exchange validates and consumes it.
    const code = crypto.randomUUID();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
    const codeHash = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await env.DB.prepare('INSERT INTO auth_exchange_codes (code_hash,claims,expires_at,created_at) VALUES (?,?,?,?)')
      .bind(codeHash, JSON.stringify({ uid, roles: ['user'], auth_method: 'google', auth_time: Math.floor(Date.now() / 1000),
        cred: credentialContext('app_bound', app) }), Date.now() + 60_000, Date.now()).run();
    started.callback.searchParams.set('code', code);
    const response = await handleAuthRoute(new Request(started.callback, { headers: { Cookie: started.nonceCookie } }), hostEnv, route(app));
    expect(response?.status).toBe(303);
    expect(response!.headers.get('Location')).toBe(`${clientOrigin}${returnPath}`);
    cookie = response!.headers.get('Set-Cookie')!.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))![0];
    auth.isSignedIn = true;
    expect((await SELF.fetch(`${BASE}/v1/auth/code/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }) })).status).toBe(400); // one-time code consumed
  };
  return { sdk, send, start, login };
}

beforeEach(async () => {
  mockNetwork(); // Runtime setup also denies every external network destination.
  for (const table of ['auth_exchange_codes', 'app_team_public_profiles', 'app_referral_events', 'app_referral_attributions',
    'app_user_activations', 'app_promoter_events', 'app_promoters', 'app_promoter_settings', 'per_app_deleted_users', 'app_visibility', 'kv']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await resetTables();
  for (const uid of [OWNER, PROMOTER, REFEREE, ORGANIC]) await seedUser(uid);
  for (const app of ['funnel', 'funnel-other', 'funnel-unknown']) await seedApp(app, OWNER);
  await seedReferralReady(env.DB, 'funnel', 'funnel-other');
  await env.DB.prepare("INSERT INTO team_members (app_id,user_id,role,created_at) VALUES ('funnel',?,'owner',1)").bind(OWNER).run();
});

describe('connected promoter API funnel on real workerd/D1 (#555 fallback)', () => {
  it('enrolls without ownership, survives interrupted login, confirms once, separates organic acquisition and honors public consent', async () => {
    expect(await env.DB.prepare('SELECT id FROM apps WHERE creator_id = ?').bind(PROMOTER).all()).toMatchObject({ results: [] });
    const readiness = await parsed<{ referral_tracking: { ready: boolean } }>(await SELF.fetch(`${BASE}/v1/storefront/promoters/apps/funnel/readiness`));
    expect(readiness.referral_tracking.ready).toBe(true);
    const { promoter } = await enroll();
    expect(promoter.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect((await enroll()).promoter).toEqual(promoter); // enrollment retry preserves link
    expect((await parsed<Enrollment>(await person('GET', '/apps/funnel/promoters/me'))).promoter).toEqual(promoter);
    const share = new URL(promoter.share_url);
    expect(share.pathname).toBe('/apps/funnel');
    expect(share.searchParams.get('ref')).toBe(promoter.code);
    expect(await parsed(await SELF.fetch(`${BASE}/v1/storefront/promoters/code/${promoter.code}`))).toMatchObject({ valid: true, app_id: 'funnel' });
    expect((await mine()).counts).toMatchObject({ confirmed: 0, pending: 0 });
    expect((await contributors()).contributors).toEqual([]);

    const referred = client(REFEREE);
    expect(referred.sdk().capture(promoter.share_url)).toBe(promoter.code);
    expect(await referred.sdk().claim()).toBeNull();
    await referred.start('/'); // interrupted: no callback, still signed out
    expect(await referred.sdk().claim()).toBeNull();
    expect((await mine()).counts.confirmed).toBe(0);
    await referred.login('/');
    expect((await mine()).counts.confirmed).toBe(0); // token exchange is not activation
    expect(referred.sdk().pending()?.code).toBe(promoter.code);
    expect(await referred.sdk().claim()).toEqual({ credited: false, state: 'pending' });
    expect((await mine()).counts).toMatchObject({ pending: 1, confirmed: 0 });
    expect((await referred.send('/v1/auth/me')).status).toBe(200); // authoritative operation
    for (let retry = 0; retry < 3; retry++) {
      expect((await referred.send('/v1/auth/me')).status).toBe(200);
      expect(referred.sdk().pending()).toBeNull(); // reconstructed SDK: capture consumed
      const report = await mine();
      expect(report.counts).toMatchObject({ confirmed: 1, pending: 0 });
      expect(report.share_of_referred_users).toMatchObject({ numerator: 1, denominator: 1, percent: 100 });
    }
    const organic = client(ORGANIC);
    await organic.login('/');
    expect(await organic.sdk().claim()).toBeNull();
    expect((await organic.send('/v1/auth/me')).status).toBe(200);
    const totals = await parsed<{ acquisition: unknown }>(await person('GET', '/apps/funnel/promoters/contributions', OWNER));
    expect(totals.acquisition).toMatchObject({ activations_recorded: 2, organic: 1, referred_confirmed: 1 });
    expect((await contributors()).contributors).toEqual([]); // enrollment is not consent
    const profile = { display_name: 'Synthetic promoter', visible: true, show_promotion: true };
    expect((await person('PUT', '/apps/funnel/team/public/me', PROMOTER, profile)).status).toBe(200);
    expect((await contributors()).contributors).toMatchObject([{ display_name: profile.display_name, contributions: { promotion: { confirmed_referrals: 1 } } }]);
    expect((await person('PUT', '/apps/funnel/team/public/me', PROMOTER, { ...profile, show_promotion: false })).status).toBe(200);
    expect((await contributors()).contributors).toEqual([]);
    await person('PUT', '/apps/funnel/team/public/me', PROMOTER, profile);
    expect((await person('POST', `/apps/funnel/promoters/${promoter.promoter_id}/status`, OWNER, { status: 'suspended' })).status).toBe(200);
    expect((await contributors()).contributors).toEqual([]);
    expect((await mine()).counts.confirmed).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_referral_events WHERE action = 'confirmed'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT * FROM team_members WHERE user_id = ?').bind(PROMOTER).all()).toMatchObject({ results: [] });
  });

  it('refuses unknown/unsupported enrollment and self, existing, mismatched and duplicate claims without seeding credits', async () => {
    expect((await person('POST', '/apps/funnel-unknown/promoters/enroll', PROMOTER, { consent: true })).status).toBe(403);
    await env.DB.prepare("UPDATE app_referral_readiness SET sdk_version = '1.16.101' WHERE app_id = 'funnel-other'").run();
    expect((await person('POST', '/apps/funnel-other/promoters/enroll', PROMOTER, { consent: true })).status).toBe(403);
    const { promoter } = await enroll();
    const self = client(PROMOTER);
    await self.login('/'); self.sdk().capture(promoter.share_url);
    expect(await self.sdk().claim()).toEqual({ credited: false, state: 'not_eligible' });
    const mismatch = client(REFEREE, 'funnel-other');
    await mismatch.login('/'); mismatch.sdk().capture(promoter.share_url);
    expect(await mismatch.sdk().claim()).toEqual({ credited: false, state: 'invalid_code' });
    const existing = client(ORGANIC);
    await existing.login('/');
    expect((await existing.send('/v1/auth/me')).status).toBe(200);
    // Historical non-ledger use distinguishes an existing user from a genuinely
    // new user whose first request beats the claim within the grace window.
    await env.DB.prepare("INSERT INTO kv (app_id,user_id,key,value,value_size_bytes,updated_at) VALUES ('funnel',?,'existing',x'01',1,1)").bind(ORGANIC).run();
    existing.sdk().capture(promoter.share_url);
    expect(await existing.sdk().claim()).toEqual({ credited: false, state: 'not_eligible' });
    const referred = client(REFEREE);
    await referred.login('/'); referred.sdk().capture(promoter.share_url);
    expect(await referred.sdk().claim()).toEqual({ credited: false, state: 'pending' });
    referred.sdk().capture(promoter.share_url);
    expect(await referred.sdk().claim()).toEqual({ credited: false, state: 'pending' });
    expect((await referred.send('/v1/auth/me')).status).toBe(200);
    expect((await mine()).counts.confirmed).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_referral_attributions').first()).toEqual({ n: 1 });
  });

  it('blocks external providers/network destinations rather than contacting production', async () => {
    await expect(fetch('https://accounts.google.com/o/oauth2/v2/auth')).rejects.toThrow();
    await expect(fetch('https://api.proappstore.online/v1/auth/me')).rejects.toThrow();
    await expect(fetch('https://github.com/login/oauth/authorize')).rejects.toThrow();
  });
});
