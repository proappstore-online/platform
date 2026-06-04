/**
 * PAS identity service — PAS owns its own auth (no FAS at runtime).
 *
 * Browser OAuth (GitHub, Google): `/v1/auth/:provider/start` → provider consent
 * → `/v1/auth/:provider/callback` exchanges the code, upserts the user, mints a
 * PAS-signed session token, and redirects back to `return_to#pas_session=<jwt>`.
 * `/v1/auth/me` verifies the token locally. Tokens are HS256 JWTs signed with
 * SESSION_SIGNING_KEY (see build-core/session-jwt) — every PAS worker verifies
 * them locally, so there is no `/auth/me` network round-trip and no FAS.
 *
 * Activation needs OAuth app credentials as secrets (GITHUB_CLIENT_ID/SECRET,
 * GOOGLE_CLIENT_ID/SECRET) + APP_BASE; until they're set, `start` returns 503.
 */

import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { mintSession, verifySession, type NewSession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';

export const authRoutes = new Hono<{ Bindings: Env }>();

/** Cookie that binds the OAuth `state` to the initiating browser (CSRF guard). */
const STATE_COOKIE = 'pas_oauth_state';

type Provider = 'github' | 'google';
const PROVIDERS = new Set<Provider>(['github', 'google']);

interface Profile { providerId: string; login: string; email: string | null; avatarUrl: string | null }

/** return_to must be one of our own origins — prevents the callback becoming an open redirect. */
function returnToAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      || u.hostname === 'proappstore.online' || u.hostname.endsWith('.proappstore.online');
  } catch {
    return false;
  }
}

function callbackUrl(env: Env, provider: Provider): string {
  const base = (env.APP_BASE || 'https://api.proappstore.online').replace(/\/$/, '');
  return `${base}/v1/auth/${provider}/callback`;
}

/** Roles for a freshly signed-in user: everyone's a creator; admins via ADMIN_GITHUB_IDS. */
function rolesFor(userId: string, env: Env): string[] {
  const roles = ['user', 'creator'];
  const admins = (env.ADMIN_GITHUB_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (admins.includes(userId)) roles.push('admin');
  return roles;
}

// ── GET /v1/auth/:provider/start ───────────────────────────
authRoutes.get('/auth/:provider/start', (c) => {
  const provider = c.req.param('provider') as Provider;
  if (!PROVIDERS.has(provider)) return c.text('unknown provider', 404);

  const clientId = provider === 'github' ? c.env.GITHUB_CLIENT_ID : c.env.GOOGLE_CLIENT_ID;
  if (!clientId) return c.text(`${provider} sign-in is not configured`, 503);

  const returnTo = c.req.query('return_to') || '';
  if (!returnToAllowed(returnTo)) return c.text('invalid return_to', 400);

  const state = btoa(JSON.stringify({ r: returnTo, n: crypto.randomUUID() }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Bind the state to this browser so the callback can reject forged/replayed
  // states (login CSRF). SameSite=Lax survives the top-level OAuth redirect back.
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/v1/auth', maxAge: 600 });
  const redirectUri = callbackUrl(c.env, provider);

  const authorize = new URL(
    provider === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth',
  );
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('state', state);
  if (provider === 'github') {
    authorize.searchParams.set('scope', 'read:user user:email');
  } else {
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', 'openid email profile');
  }
  return c.redirect(authorize.toString(), 302);
});

// ── GET /v1/auth/:provider/callback ────────────────────────
authRoutes.get('/auth/:provider/callback', async (c) => {
  const provider = c.req.param('provider') as Provider;
  if (!PROVIDERS.has(provider)) return c.text('unknown provider', 404);

  const stateRaw = c.req.query('state') || '';

  // CSRF: the state must match the cookie we set at /start (same browser).
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/v1/auth' });
  if (!cookieState || cookieState !== stateRaw) return c.text('invalid state', 400);

  // Recover the (own-origin) return_to from the verified state first, so any
  // later failure can bounce the user back to the app with a clean error
  // instead of a bare error page.
  let returnTo = '';
  try {
    const b64 = stateRaw.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    returnTo = (JSON.parse(json) as { r?: string }).r || '';
  } catch { /* fall through to validation */ }
  if (!returnToAllowed(returnTo)) return c.text('invalid state', 400);

  /** Bounce back to the app with `#auth_error=<reason>` (the SDK clears the hash). */
  const fail = (reason: string) => {
    const dest = new URL(returnTo);
    dest.hash = `auth_error=${encodeURIComponent(reason)}`;
    return c.redirect(dest.toString(), 302);
  };

  // The provider can redirect back with an error (e.g. the user denied consent).
  const provErr = c.req.query('error');
  if (provErr) return fail(provErr);

  const code = c.req.query('code');
  if (!code) return fail('missing_code');

  try {
    const profile = provider === 'github'
      ? await githubProfile(c.env, code)
      : await googleProfile(c.env, code);
    if (!profile) return fail('profile_fetch_failed');

    const userId = `${provider === 'github' ? 'gh' : 'google'}:${profile.providerId}`;
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO users (id, provider, provider_id, login, email, avatar_url, created_at, last_login_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, email = excluded.email,
         avatar_url = excluded.avatar_url, last_login_at = excluded.last_login_at`,
    ).bind(userId, provider, profile.providerId, profile.login, profile.email, profile.avatarUrl, now).run();

    const claims: NewSession = { uid: userId, login: profile.login, avatarUrl: profile.avatarUrl, roles: rolesFor(userId, c.env) };
    const token = await mintSession(claims, c.env.SESSION_SIGNING_KEY);

    const dest = new URL(returnTo);
    dest.hash = `pas_session=${encodeURIComponent(token)}`;
    return c.redirect(dest.toString(), 302);
  } catch {
    return fail('server_error');
  }
});

// ── GET /v1/auth/me ────────────────────────────────────────
authRoutes.get('/auth/me', async (c) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) throw new HttpError('missing bearer token', 401);
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) throw new HttpError('invalid or expired session', 401);
  return c.json({
    id: claims.uid,
    login: claims.login,
    avatarUrl: claims.avatarUrl ?? null,
    roles: claims.roles,
    appRoles: claims.appRoles ?? {},
  });
});

// ── PATCH /v1/auth/me/date-of-birth ────────────────────────
authRoutes.patch('/auth/me/date-of-birth', async (c) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) throw new HttpError('missing bearer token', 401);
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) throw new HttpError('invalid or expired session', 401);

  const body = await c.req.json<{ dateOfBirth?: string }>().catch(() => ({} as { dateOfBirth?: string }));
  const dob = body.dateOfBirth;
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError('dateOfBirth must be YYYY-MM-DD', 400);
  const age = (Date.now() - new Date(dob + 'T00:00:00Z').getTime()) / (365.25 * 24 * 3600 * 1000);
  if (!(age >= 13)) throw new HttpError('must be at least 13', 400);

  const existing = await c.env.DB.prepare('SELECT date_of_birth FROM users WHERE id = ?').bind(claims.uid).first<{ date_of_birth: string | null }>();
  if (existing?.date_of_birth) throw new HttpError('date of birth already set', 409);
  await c.env.DB.prepare('UPDATE users SET date_of_birth = ? WHERE id = ?').bind(dob, claims.uid).run();
  return c.json({ id: claims.uid, login: claims.login, avatarUrl: claims.avatarUrl ?? null, roles: claims.roles, appRoles: claims.appRoles ?? {} });
});

// ── POST /v1/auth/email/start ──────────────────────────────
// Magic-link sign-in needs an email sender; not wired on PAS yet. Use GitHub or
// Google. (Returns 501 rather than silently failing so the SDK surfaces it.)
authRoutes.post('/auth/email/start', (c) => c.json({ error: 'email sign-in is not enabled yet — use GitHub or Google' }, 501));

// ── Provider profile fetchers ──────────────────────────────
async function githubProfile(env: Env, code: string): Promise<Profile | null> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callbackUrl(env, 'github') }),
  });
  if (!tokenRes.ok) return null;
  const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!accessToken) return null;

  const ua = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'proappstore-auth' };
  const userRes = await fetch('https://api.github.com/user', { headers: ua });
  if (!userRes.ok) return null;
  const u = (await userRes.json()) as { id: number; login: string; avatar_url?: string; email?: string | null };

  let email = u.email ?? null;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ua });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    }
  }
  return { providerId: String(u.id), login: u.login, email, avatarUrl: u.avatar_url ?? null };
}

async function googleProfile(env: Env, code: string): Promise<Profile | null> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: callbackUrl(env, 'google'), grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return null;
  const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!accessToken) return null;

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!infoRes.ok) return null;
  const info = (await infoRes.json()) as { sub: string; name?: string; email?: string; picture?: string };
  const login = info.name || (info.email ? info.email.split('@')[0]! : info.sub);
  return { providerId: info.sub, login, email: info.email ?? null, avatarUrl: info.picture ?? null };
}
