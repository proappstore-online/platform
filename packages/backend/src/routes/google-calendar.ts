import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireUser, stepUpMaxAgeSeconds, type FasUser } from '../lib/auth.js';
import { redeemExchangeCode } from './auth.js';
import { account } from '../lib/google-calendar-credentials.js';
import { disconnectGoogleAccount, disconnectGoogleApp, listGoogleConnections } from '../lib/google-calendar-accounts.js';
import { googleAuthorizationUrl, oauthState, type OAuthState } from '../lib/google-calendar-oauth.js';
import { GoogleCalendarError, hashState, randomState } from '../lib/google-calendar-common.js';
import { googleCapabilities } from '../lib/google-calendar-policy.js';
import { googleAccessPage, googleSignInPage, googleConsentPage as page } from '../lib/google-calendar-consent-page.js';
import { parseCredentialContext, type CredentialContext } from '../lib/accounts/credential-context.js';

export const googleCalendarRoutes = new Hono<{ Bindings: Env }>();
type Ctx = Context<{ Bindings: Env }>;
const PREFIX = '/v1/connectors/google-calendar';
const cookieName = (pending: OAuthState) => `__Host-pas_google_consent_${pending.state_hash}`;
const base = (env: Env) => new URL(env.APP_BASE || 'https://api.proappstore.online').origin;
const consentUrl = (state: string) => `${PREFIX}/consent?state=${encodeURIComponent(state)}`;
const safeError = (c: Ctx) => c.html(html`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google connection</title><main><h1>Start again from your app</h1><p>This connection request expired, changed, or could not be verified. Return to your app and connect again.</p></main>`, 400);

// A top-level, PAS-owned surface: no cache, third-party scripts, framing or referrer leakage.
googleCalendarRoutes.use('/connectors/google-calendar/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});
function requireOrigin(c: Ctx) {
  if (c.req.header('Origin') !== base(c.env)) throw new GoogleCalendarError('invalid_origin', 403);
}
async function browserMatches(c: Ctx, pending: OAuthState) {
  const cookie = getCookie(c, cookieName(pending));
  return pending.browser_verified_at !== null && !!cookie && !!pending.browser_hash && await hashState(cookie) === pending.browser_hash;
}
interface ConsentIdentity {
  uid: string; authTime: number | undefined; authMethod: string | undefined;
  context: CredentialContext | null; via: string | undefined;
}
async function bindBrowser(c: Ctx, state: string, identity: ConsentIdentity) {
  const { uid, authTime, authMethod, context, via } = identity;
  const pending = await oauthState(c.env, state);
  if (uid !== pending.user_id) throw new GoogleCalendarError('wrong_pas_account', 403);
  if (context?.kind !== 'first_party_session' || via) throw new GoogleCalendarError('personal_sign_in_required', 403);
  const age = Math.floor(Date.now() / 1000) - (authTime ?? 0);
  if (age < -30 || age > stepUpMaxAgeSeconds(c.env) || !['google', 'github', 'password', 'passkey'].includes(authMethod ?? '')) throw new GoogleCalendarError('recent_sign_in_required', 403);
  const cookie = randomState();
  const changed = await c.env.DB.prepare('UPDATE google_calendar_oauth_states SET browser_hash = ?, browser_verified_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND consented_at IS NULL AND expires_at > ?')
    .bind(await hashState(cookie), Date.now(), await hashState(state), Date.now()).run();
  if (!changed.meta.changes) throw new GoogleCalendarError('expired_or_used_callback', 409);
  setCookie(c, cookieName(pending), cookie, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
}

googleCalendarRoutes.get('/connectors/google-calendar/consent', async c => {
  try {
    const state = c.req.query('state') ?? '', pending = await oauthState(c.env, state);
    const app = await c.env.DB.prepare('SELECT (SELECT name FROM submissions WHERE app_id = apps.id ORDER BY created_at DESC LIMIT 1) AS name FROM apps WHERE id = ?').bind(pending.app_id).first<{ name: string | null }>();
    const name = app?.name || pending.app_id;
    if (pending.consented_at !== null) {
      if (pending.browser_verified_at === null) return safeError(c);
      return page(c, html`<h1>Consent already saved</h1><p>Continue in the Google window, or start again from your app.</p>`);
    }
    if (!await browserMatches(c, pending)) {
      const destination = `${base(c.env)}${PREFIX}/session?state=${state}`;
      const signIn = (provider: string) => `/v1/auth/${provider}/start?${new URLSearchParams({ return_to: destination, response_mode: 'query' })}`;
      return googleSignInPage(c, { pending, name, signIn: { google: signIn('google'), github: signIn('github') }, sessionUrl: `${PREFIX}/session?state=${state}` });
    }
    const csrf = await hashState(`${getCookie(c, cookieName(pending))}:${state}:approve`);
    return googleAccessPage(c, { pending, name, action: consentUrl(state), csrf, shared: await account(c.env, pending.user_id) });
  } catch { return safeError(c); }
});

googleCalendarRoutes.get('/connectors/google-calendar/session', async c => {
  try {
    const state = c.req.query('state') ?? '', code = c.req.query('code');
    if (!code) return safeError(c);
    const session = await redeemExchangeCode(c.env, code), claims = session && await verifySession(session, c.env.SESSION_SIGNING_KEY);
    if (!claims) return safeError(c);
    await bindBrowser(c, state, { uid: claims.uid, authTime: claims.auth_time, authMethod: claims.auth_method, context: parseCredentialContext(claims.cred), via: claims.via });
    return c.redirect(consentUrl(state), 302);
  } catch { return safeError(c); }
});
googleCalendarRoutes.post('/connectors/google-calendar/session', async c => {
  try {
    requireOrigin(c);
    const user = await requireUser(c);
    await bindBrowser(c, c.req.query('state') ?? '', { uid: user.id, authTime: user.authTime, authMethod: user.authMethod, context: user.credentialContext, via: user.via });
    return c.json({ ok: true });
  } catch { return c.json({ error: 'Sign in with the same ProAppStore account that started this connection.' }, 403); }
});

googleCalendarRoutes.post('/connectors/google-calendar/consent', async c => {
  try {
    requireOrigin(c);
    const state = c.req.query('state') ?? '', pending = await oauthState(c.env, state);
    if (!await browserMatches(c, pending) || pending.consented_at !== null) throw new GoogleCalendarError('invalid_browser', 403);
    const body = await c.req.formData();
    if (body.get('csrf') !== await hashState(`${getCookie(c, cookieName(pending))}:${state}:approve`)) throw new GoogleCalendarError('invalid_csrf', 403);
    if (body.get('decision') === 'disconnect_all') {
      if (body.get('confirm_global') !== 'yes') throw new GoogleCalendarError('confirmation_required', 403);
      await disconnectGoogleAccount(c.env, pending.user_id, Number(body.get('expected_version')));
      deleteCookie(c, cookieName(pending), { path: '/', secure: true });
      return page(c, html`<h1>Google disconnected</h1><p>Google access has stopped for all of your Pro apps. Records already saved by apps have not been deleted.</p><a class="button" href="${pending.return_to}">Return to your app</a><p>Start a new connection there to choose a different Google account.</p>`);
    }
    if (body.get('decision') === 'deny') {
      await c.env.DB.prepare('DELETE FROM google_calendar_oauth_states WHERE state_hash = ?').bind(await hashState(state)).run();
      deleteCookie(c, cookieName(pending), { path: '/', secure: true });
      const destination = new URL(pending.callback_url); destination.searchParams.set('error', 'google_cancelled');
      destination.searchParams.set('state', state);
      return c.redirect(destination.href, 302);
    }
    if (body.get('decision') !== 'allow') throw new GoogleCalendarError('invalid_decision');
    const requested = googleCapabilities(JSON.parse(pending.capabilities_json)), selected = googleCapabilities(body.getAll('capability'));
    if (!selected.every(capability => requested.includes(capability))) throw new GoogleCalendarError('capability_not_requested', 403);
    const accepted = Date.now();
    const saved = await c.env.DB.prepare(`UPDATE google_calendar_oauth_states SET capabilities_json = ?, consented_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND consented_at IS NULL AND browser_hash = ? AND expires_at > ?
      AND EXISTS (SELECT 1 FROM app_connectors k WHERE k.app_id = google_calendar_oauth_states.app_id AND k.kind = 'google_calendar' AND k.contract_hash = google_calendar_oauth_states.contract_hash)`)
      .bind(JSON.stringify(selected), accepted, await hashState(state), pending.browser_hash, accepted).run();
    if (!saved.meta.changes) throw new GoogleCalendarError('expired_or_used_callback', 409);
    return c.redirect(await googleAuthorizationUrl(c.env, state, { ...pending, capabilities_json: JSON.stringify(selected), consented_at: accepted }), 302);
  } catch { return safeError(c); }
});

/** No token exchange here: the initiating app/user still completes the one-use callback. */
googleCalendarRoutes.get('/connectors/google-calendar/callback', async c => {
  c.header('Referrer-Policy', 'no-referrer');
  try {
    const state = c.req.query('state') ?? '', pending = await oauthState(c.env, state);
    if (pending.consented_at === null || !await browserMatches(c, pending)) return safeError(c);
    const destination = new URL(pending.callback_url), code = c.req.query('code');
    if (c.req.query('error')) destination.searchParams.set('error', 'google_cancelled');
    else if (code && code.length <= 4096) destination.searchParams.set('code', code);
    else return c.text('Missing Google response. Start again from app settings.', 400);
    destination.searchParams.set('state', state);
    deleteCookie(c, cookieName(pending), { path: '/', secure: true });
    return c.redirect(destination.href, 302);
  } catch { return safeError(c); }
});

/**
 * User connection management (#537). The signed-in person inspects what each app can use and revokes one
 * app, or separately disconnects the shared account. Only a first-party person session may do this: an
 * app-bound, workload or machine credential must never be able to end another app's access, and an
 * app's own disconnect button is not the only control.
 */
async function connectionOwner(c: Ctx, recent = false): Promise<FasUser> {
  const user = await requireUser(c);
  if (user.credentialContext?.kind !== 'first_party_session' || user.via) throw new GoogleCalendarError('personal_sign_in_required', 403);
  if (recent) {
    const age = Math.floor(Date.now() / 1000) - (user.authTime ?? 0);
    if (age < -30 || age > stepUpMaxAgeSeconds(c.env) || !['google', 'github', 'password', 'passkey'].includes(user.authMethod ?? '')) throw new GoogleCalendarError('recent_sign_in_required', 403);
  }
  return user;
}
async function managed(c: Ctx, run: () => Promise<unknown>) {
  try { return c.json(await run()); } catch (error) {
    if (error instanceof GoogleCalendarError) return c.json({ error: error.code }, error.status as 400);
    throw error;
  }
}
const requestBody = async (c: Ctx) => await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));

googleCalendarRoutes.get('/connectors/google-calendar/connections', c => managed(c, async () => {
  const user = await connectionOwner(c);
  const connections = await listGoogleConnections(c.env, user.id);
  return { ...connections, warning: connections.account && 'Disconnecting the Google account ends Google access for every app listed here. Records an app already saved are not deleted.' };
}));
googleCalendarRoutes.post('/connectors/google-calendar/connections/apps/:appId/revoke', c => managed(c, async () => {
  const user = await connectionOwner(c);
  return disconnectGoogleApp(c.env, c.req.param('appId'), user.id, (await requestBody(c)).expected_authorization_version);
}));
googleCalendarRoutes.post('/connectors/google-calendar/connections/disconnect', c => managed(c, async () => {
  const user = await connectionOwner(c, true);
  const body = await requestBody(c);
  return disconnectGoogleAccount(c.env, user.id, body.expected_version, { acknowledgedApps: body.acknowledged_apps });
}));
