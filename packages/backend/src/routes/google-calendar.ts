import { Hono, type Context } from 'hono';
import { html, raw } from 'hono/html';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireUser, stepUpMaxAgeSeconds } from '../lib/auth.js';
import { redeemExchangeCode } from './auth.js';
import { account, disconnectGoogleAccount, googleAuthorizationUrl, oauthState, type OAuthState } from '../lib/google-calendar-accounts.js';
import { GoogleCalendarError, hashState, randomState } from '../lib/google-calendar-common.js';
import { googleCapabilities, googleDisclosure } from '../lib/google-calendar-policy.js';

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
  return !!cookie && !!pending.browser_hash && await hashState(cookie) === pending.browser_hash;
}
async function bindBrowser(c: Ctx, state: string, uid: string, authTime: number | undefined, authMethod: string | undefined) {
  const pending = await oauthState(c.env, state);
  if (uid !== pending.user_id) throw new GoogleCalendarError('wrong_pas_account', 403);
  const age = Math.floor(Date.now() / 1000) - (authTime ?? 0);
  if (age < -30 || age > stepUpMaxAgeSeconds(c.env) || !['google', 'github', 'password', 'passkey'].includes(authMethod ?? '')) throw new GoogleCalendarError('recent_sign_in_required', 403);
  const cookie = randomState();
  const changed = await c.env.DB.prepare('UPDATE google_calendar_oauth_states SET browser_hash = ? WHERE state_hash = ? AND consumed_at IS NULL AND consented_at IS NULL AND expires_at > ?')
    .bind(await hashState(cookie), await hashState(state), Date.now()).run();
  if (!changed.meta.changes) throw new GoogleCalendarError('expired_or_used_callback', 409);
  setCookie(c, cookieName(pending), cookie, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
}

const styles = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.5;overflow-wrap:anywhere}*{box-sizing:border-box}body{margin:0;padding:20px;background:light-dark(#f8fafc,#111827);color:light-dark(#172033,#f3f4f6)}main{max-width:36rem;margin:24px auto}h1{font-size:1.65rem;line-height:1.2}h2{font-size:1rem;margin:22px 0 4px}p{margin:8px 0}a{color:light-dark(#1d4ed8,#93c5fd)}label{display:block;margin:12px 0}input:not([type=checkbox]){width:100%;font:inherit;padding:10px;border:1px solid #94a3b8;border-radius:8px}input[type=checkbox]{width:20px;height:20px;vertical-align:middle;margin-right:8px}button,.button{display:inline-block;min-height:44px;padding:11px 16px;font:inherit;border:0;border-radius:8px;background:#2563eb;color:white;text-decoration:none;cursor:pointer;margin:8px 6px 0 0}.secondary{background:light-dark(#e2e8f0,#334155);color:inherit}.card{padding:16px;border:1px solid #94a3b8;border-radius:12px;margin:16px 0}.muted{font-size:.9rem;color:light-dark(#475569,#cbd5e1)}[role=alert]{color:light-dark(#991b1b,#fca5a5)}form{margin-top:16px}footer{font-size:.9rem;margin-top:24px}`;
const credentialScript = `document.querySelector('#credentials')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,error=document.querySelector('[role=alert]');error.textContent='';const data=new FormData(form);try{const response=await fetch('/v1/auth/credentials/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:data.get('login'),password:data.get('password')})});form.querySelector('[name=password]').value='';const result=await response.json();if(!response.ok||!result.token)throw Error('Sign-in failed. Check your details and try again.');const bound=await fetch(form.dataset.session,{method:'POST',headers:{Authorization:'Bearer '+result.token}});if(!bound.ok)throw Error('Sign in with the same ProAppStore account that started this connection.');location.reload()}catch(failure){error.textContent=failure.message}});`;
function page(c: Ctx, body: ReturnType<typeof html>, script = '') {
  const nonce = randomState();
  c.header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`);
  return c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Google · ProAppStore</title><style nonce="${nonce}">${raw(styles)}</style></head><body><main><a href="https://proappstore.online/">ProAppStore</a>${body}<footer><a href="https://proappstore.online/privacy#google-data" target="_blank" rel="noopener noreferrer">Platform privacy</a></footer></main>${script ? html`<script nonce="${nonce}">${raw(script)}</script>` : ''}</body></html>`);
}

googleCalendarRoutes.get('/connectors/google-calendar/consent', async c => {
  try {
    const state = c.req.query('state') ?? '', pending = await oauthState(c.env, state);
    const app = await c.env.DB.prepare('SELECT (SELECT name FROM submissions WHERE app_id = apps.id ORDER BY created_at DESC LIMIT 1) AS name FROM apps WHERE id = ?').bind(pending.app_id).first<{ name: string | null }>();
    const name = app?.name || pending.app_id;
    if (pending.consented_at !== null) return page(c, html`<h1>Consent already saved</h1><p>Continue in the Google window, or start again from your app.</p>`);
    if (!await browserMatches(c, pending)) {
      const destination = `${base(c.env)}${PREFIX}/session?state=${state}`;
      const signIn = (provider: string) => `/v1/auth/${provider}/start?${new URLSearchParams({ return_to: destination, response_mode: 'query' })}`;
      return page(c, html`<h1>Connect Google to ${name}</h1><p class="muted">${new URL(pending.callback_url).origin}</p><p>First, confirm the ProAppStore account you used in the app.</p><a class="button" href="${signIn('google')}">Sign in with Google</a><a class="button secondary" href="${signIn('github')}">Sign in with GitHub</a><details><summary>Use email or username</summary><form id="credentials" method="post" action="/v1/auth/credentials/login" data-session="${PREFIX}/session?state=${state}"><label>Email or username<input name="login" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form><p role="alert"></p></details><p class="muted">Google access is optional. No access is granted by opening this page.</p>`, credentialScript);
    }
    const disclosure = googleDisclosure(JSON.parse(pending.disclosure_json!));
    const capabilities = googleCapabilities(JSON.parse(pending.capabilities_json));
    const csrf = await hashState(`${getCookie(c, cookieName(pending))}:${state}:approve`);
    const shared = await account(c.env, pending.user_id);
    const changeAccount = shared?.status === 'connected' ? html`<details><summary>Use a different Google account</summary><p>Google is currently connected as ${shared.email}. Changing this shared account first disconnects Google from every Pro app.</p><form method="post" action="${consentUrl(state)}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="decision" value="disconnect_all"><input type="hidden" name="expected_version" value="${shared.version}"><label><input type="checkbox" name="confirm_global" value="yes" required>Disconnect Google for all of my apps</label><button class="secondary">Disconnect all apps</button></form></details>` : '';
    return page(c, html`<h1>Connect Google to ${name}</h1><p class="muted">${new URL(pending.callback_url).origin}</p><p>${disclosure.purpose}</p><form method="post" action="${consentUrl(state)}"><input type="hidden" name="csrf" value="${csrf}"><div class="card"><h2>Choose access</h2><label><input type="checkbox" name="capability" value="calendar.read" checked required>Read calendars and events</label><p class="muted">List calendars so you can select one, then read its meeting titles, times and links. No editing.</p>${capabilities.includes('meet.read') ? html`<label><input type="checkbox" name="capability" value="meet.read" checked>Read related Google Meet records</label><p class="muted">Participant identities and names, conference times, and join/leave sessions. Meet data must not be collected for performance tracking or user evaluation.</p>` : ''}</div><h2>Who can see the data</h2><p>${disclosure.audience}</p><h2>How long it is kept</h2><p>${disclosure.retention}</p><p><a href="${new URL(disclosure.privacy_path, pending.callback_url).href}" target="_blank" rel="noopener noreferrer">App privacy</a> · <a href="${new URL(disclosure.deletion_path, pending.callback_url).href}" target="_blank" rel="noopener noreferrer">Delete saved app data</a></p><p class="muted">PAS keeps encrypted Google credentials. This app receives only the access you choose. Disconnecting stops future reads; it does not erase records the app already saved. Connecting this app will not disconnect your other apps.</p><button name="decision" value="allow">Continue to Google</button><button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button></form>${changeAccount}`);
  } catch { return safeError(c); }
});

googleCalendarRoutes.get('/connectors/google-calendar/session', async c => {
  try {
    const state = c.req.query('state') ?? '', code = c.req.query('code');
    if (!code) return safeError(c);
    const session = await redeemExchangeCode(c.env, code), claims = session && await verifySession(session, c.env.SESSION_SIGNING_KEY);
    if (!claims) return safeError(c);
    await bindBrowser(c, state, claims.uid, claims.auth_time, claims.auth_method);
    return c.redirect(consentUrl(state), 302);
  } catch { return safeError(c); }
});
googleCalendarRoutes.post('/connectors/google-calendar/session', async c => {
  try {
    requireOrigin(c);
    const user = await requireUser(c);
    await bindBrowser(c, c.req.query('state') ?? '', user.id, user.authTime, user.authMethod);
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
