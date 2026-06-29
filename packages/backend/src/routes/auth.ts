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
import { mintSession, verifySession, type NewSession, type SessionClaims } from '@proappstore/build-core';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { generateLogin, generatePassword, normalizeLogin, isValidLogin } from '../lib/credential-gen.js';
import { d1AttemptStore, isBlocked, recordFailure, recordSuccess } from '../lib/credential-rate-limit.js';

export const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * Verify the Bearer token as a PAS-signed session, locally (no FAS round-trip).
 * Returns the claims or throws 401. Shared by /auth/me, the date-of-birth
 * patch, and credential provisioning.
 */
async function requireClaims(c: Context<{ Bindings: Env }>): Promise<SessionClaims> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) throw new HttpError('missing bearer token', 401);
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) throw new HttpError('invalid or expired session', 401);
  return claims;
}

async function authUserDto(env: Env, claims: SessionClaims) {
  const row = await env.DB.prepare('SELECT login, avatar_url, date_of_birth FROM users WHERE id = ?')
    .bind(claims.uid)
    .first<{ login: string | null; avatar_url: string | null; date_of_birth: string | null }>();
  const login = claims.login ?? row?.login ?? claims.uid;
  const avatarUrl = claims.avatarUrl ?? row?.avatar_url ?? null;
  return {
    id: claims.uid,
    name: login,
    login,
    avatarUrl,
    dateOfBirth: row?.date_of_birth ?? null,
    roles: claims.roles,
    appRoles: claims.appRoles ?? {},
  };
}

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
      || u.hostname === 'proappstore.online' || u.hostname.endsWith('.proappstore.online')
      || u.hostname === 'proideastore.online' || u.hostname.endsWith('.proideastore.online');
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
  const responseMode = c.req.query('response_mode') === 'query' ? 'query' : 'fragment';

  const state = btoa(JSON.stringify({ r: returnTo, m: responseMode, n: crypto.randomUUID() }))
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
  let responseMode: 'fragment' | 'query' = 'fragment';
  try {
    const b64 = stateRaw.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const parsed = JSON.parse(json) as { r?: string; m?: string };
    returnTo = parsed.r || '';
    if (parsed.m === 'query') responseMode = 'query';
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
    if (responseMode === 'query') {
      dest.searchParams.set('session', token);
    } else {
      dest.hash = `pas_session=${encodeURIComponent(token)}`;
    }
    return c.redirect(dest.toString(), 302);
  } catch {
    return fail('server_error');
  }
});

// ── GET /v1/auth/me ────────────────────────────────────────
authRoutes.get('/auth/me', async (c) => {
  const claims = await requireClaims(c);
  return c.json(await authUserDto(c.env, claims));
});

// ── PATCH /v1/auth/me/date-of-birth ────────────────────────
authRoutes.patch('/auth/me/date-of-birth', async (c) => {
  const claims = await requireClaims(c);

  const body = await c.req.json<{ dateOfBirth?: string }>().catch(() => ({} as { dateOfBirth?: string }));
  const dob = body.dateOfBirth;
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError('dateOfBirth must be YYYY-MM-DD', 400);
  const age = (Date.now() - new Date(dob + 'T00:00:00Z').getTime()) / (365.25 * 24 * 3600 * 1000);
  if (!(age >= 13)) throw new HttpError('must be at least 13', 400);

  const existing = await c.env.DB.prepare('SELECT date_of_birth FROM users WHERE id = ?').bind(claims.uid).first<{ date_of_birth: string | null }>();
  if (existing?.date_of_birth) throw new HttpError('date of birth already set', 409);
  await c.env.DB.prepare('UPDATE users SET date_of_birth = ? WHERE id = ?').bind(dob, claims.uid).run();
  return c.json({ ...(await authUserDto(c.env, claims)), dateOfBirth: dob });
});

// ── POST /v1/auth/email/start ──────────────────────────────
// Magic-link sign-in needs an email sender; not wired on PAS yet. Use GitHub or
// Google. (Returns 501 rather than silently failing so the SDK surfaces it.)
authRoutes.post('/auth/email/start', (c) => c.json({ error: 'email sign-in is not enabled yet — use GitHub or Google' }, 501));

// ── POST /v1/auth/credentials/provision ────────────────────
// An authenticated adult (creator) provisions a child/student account that
// signs in with a username + password — no email, no OAuth. Returns the
// login + password ONCE (the password is never retrievable again). Built for
// kids who don't have email (chess-academy); generalizes to any education
// product. This is NOT public self-registration — provisioning is gated.
authRoutes.post('/auth/credentials/provision', async (c) => {
  const claims = await requireClaims(c);
  // Only creators provision accounts. Credential (child) accounts get only the
  // 'user' role, so this also prevents a provisioned child provisioning others.
  if (!claims.roles.includes('creator')) throw new HttpError('only creators can provision accounts', 403);

  const body = await c.req
    .json<{ login?: string; displayName?: string; isChild?: boolean; password?: string }>()
    .catch(() => ({} as { login?: string; displayName?: string; isChild?: boolean; password?: string }));

  // A supplied login is used as-is (and a collision is a hard 409); otherwise we
  // generate animal triples and retry past the rare collision.
  const supplied = typeof body.login === 'string' && body.login.trim() !== '';
  let suppliedLogin = '';
  if (supplied) {
    suppliedLogin = normalizeLogin(body.login!);
    if (!isValidLogin(suppliedLogin)) {
      throw new HttpError('login must be lowercase letters, digits, and hyphens (3–64 chars)', 400);
    }
  }

  if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 6)) {
    throw new HttpError('password must be at least 6 characters', 400);
  }
  const password = body.password ?? generatePassword();
  const passwordHash = await hashPassword(password);

  const isChild = body.isChild !== false; // default true — the primary use case
  const now = Date.now();

  const attempts = supplied ? 1 : 6;
  for (let i = 0; i < attempts; i++) {
    const login = supplied ? suppliedLogin : generateLogin();
    const uid = `cred:${crypto.randomUUID()}`;
    const display = (body.displayName ?? '').trim() || login;
    try {
      await c.env.DB.prepare(
        `INSERT INTO users (id, provider, provider_id, login, email, avatar_url, is_child,
           credential_login, password_hash, created_by, created_at, last_login_at)
         VALUES (?1, 'credential', ?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6, ?7, ?7)`,
      ).bind(uid, display, isChild ? 1 : 0, login, passwordHash, claims.uid, now).run();

      // Returned ONCE — the password is not stored in plaintext and can't be
      // fetched again. If lost, the adult re-provisions / resets.
      return c.json({ uid, login, password, isChild });
    } catch (err) {
      const isUnique = err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
      if (isUnique && supplied) throw new HttpError('that login is already taken', 409);
      if (isUnique) continue; // generated collision — try a fresh triple
      throw err;
    }
  }
  throw new HttpError('could not generate a unique login, please retry', 503);
});

// ── POST /v1/auth/credentials/login ────────────────────────
// No auth. Verify login + password, mint a standard PAS session JWT — identical
// shape to the OAuth path, so every downstream verifier is unchanged. Failed
// attempts are rate-limited per login (lib/credential-rate-limit).
authRoutes.post('/auth/credentials/login', async (c) => {
  const body = await c.req
    .json<{ login?: string; password?: string }>()
    .catch(() => ({} as { login?: string; password?: string }));
  const login = typeof body.login === 'string' ? normalizeLogin(body.login) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!login || !password) throw new HttpError('login and password are required', 400);

  const store = d1AttemptStore(c.env.DB);
  const now = Date.now();
  if (await isBlocked(store, login, now)) {
    throw new HttpError('too many sign-in attempts — please try again later', 429);
  }

  const row = await c.env.DB.prepare(
    'SELECT id, login, password_hash FROM users WHERE credential_login = ?',
  ).bind(login).first<{ id: string; login: string; password_hash: string | null }>();

  const ok = !!row?.password_hash && (await verifyPassword(password, row.password_hash));
  if (!ok || !row) {
    await recordFailure(store, login, now);
    // Same message whether the login exists or not — no account enumeration.
    throw new HttpError('invalid login or password', 401);
  }

  await recordSuccess(store, login);
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, row.id).run();

  // Credential accounts are plain users (never 'creator'/'admin').
  const session: NewSession = { uid: row.id, login: row.login, avatarUrl: null, roles: ['user'] };
  const token = await mintSession(session, c.env.SESSION_SIGNING_KEY);
  return c.json({ token });
});

// ── POST /v1/auth/credentials/reset-password ───────────────
// An authenticated adult resets the password of a credential (child) account.
// Returns the new random password ONCE — the adult shows it to the child.
authRoutes.post('/auth/credentials/reset-password', async (c) => {
  const claims = await requireClaims(c);
  if (!claims.roles.includes('creator')) throw new HttpError('only creators can reset passwords', 403);

  const body = await c.req
    .json<{ targetUserId?: string }>()
    .catch(() => ({} as { targetUserId?: string }));
  const targetId = body.targetUserId;
  if (!targetId || typeof targetId !== 'string') throw new HttpError('targetUserId is required', 400);
  if (!targetId.startsWith('cred:')) throw new HttpError('can only reset credential accounts', 400);

  // Verify the target exists and is a credential account
  const target = await c.env.DB.prepare(
    'SELECT id, credential_login, created_by FROM users WHERE id = ? AND provider = ?',
  ).bind(targetId, 'credential').first<{ id: string; credential_login: string; created_by: string | null }>();
  if (!target) throw new HttpError('account not found', 404);

  // SECURITY: only the adult who created this credential account (or an admin)
  // may reset its password. Without this, every 'creator' (which is every
  // signed-in user) could reset ANY credential account and read the new
  // password from the response — full cross-tenant account takeover.
  if (target.created_by !== claims.uid && !claims.roles.includes('admin')) {
    throw new HttpError('not your account', 403);
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ?',
  ).bind(passwordHash, targetId).run();

  return c.json({ password });
});

// ── POST /v1/auth/credentials/change-password ──────────────
// A signed-in credential (student) account changes their own password.
// Requires the current password for verification.
authRoutes.post('/auth/credentials/change-password', async (c) => {
  const claims = await requireClaims(c);
  if (!claims.uid.startsWith('cred:')) throw new HttpError('only credential accounts can change passwords', 403);

  const body = await c.req
    .json<{ currentPassword?: string; newPassword?: string }>()
    .catch(() => ({} as { currentPassword?: string; newPassword?: string }));
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!currentPassword || !newPassword) throw new HttpError('currentPassword and newPassword are required', 400);
  if (newPassword.length < 6) throw new HttpError('new password must be at least 6 characters', 400);

  const row = await c.env.DB.prepare(
    'SELECT id, password_hash FROM users WHERE id = ?',
  ).bind(claims.uid).first<{ id: string; password_hash: string | null }>();
  if (!row?.password_hash) throw new HttpError('account not found', 404);

  const ok = await verifyPassword(currentPassword, row.password_hash);
  if (!ok) throw new HttpError('current password is incorrect', 403);

  const passwordHash = await hashPassword(newPassword);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ?',
  ).bind(passwordHash, claims.uid).run();

  return c.json({ ok: true });
});

// ── POST /v1/auth/exchange ────────────────────────────────
// Swap a GitHub device-flow access token for a PAS session token.
// Used by `pas login` (CLI). Verifies the token against GitHub /user,
// upserts the user row, mints a PAS session.
authRoutes.post('/auth/exchange', async (c) => {
  let body: { githubToken?: string };
  try { body = await c.req.json(); } catch { return c.text('invalid json', 400); }
  const githubToken = body.githubToken;
  if (!githubToken || typeof githubToken !== 'string') return c.text('missing githubToken', 400);

  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'proappstore-api' },
  });
  if (userRes.status === 401) return c.text('invalid github token', 401);
  if (!userRes.ok) return c.text(`github error: ${userRes.status}`, 502);
  const ghUser = (await userRes.json()) as { id: number; login: string; avatar_url?: string; email?: string | null };

  const userId = `gh:${ghUser.id}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO users (id, provider, provider_id, login, email, avatar_url, created_at, last_login_at)
     VALUES (?1, 'github', ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(id) DO UPDATE SET login = excluded.login, email = excluded.email,
       avatar_url = excluded.avatar_url, last_login_at = excluded.last_login_at`,
  ).bind(userId, String(ghUser.id), ghUser.login, ghUser.email ?? null, ghUser.avatar_url ?? null, now).run();

  const claims: NewSession = { uid: userId, login: ghUser.login, avatarUrl: ghUser.avatar_url ?? null, roles: rolesFor(userId, c.env) };
  const sessionToken = await mintSession(claims, c.env.SESSION_SIGNING_KEY);
  return c.json({ sessionToken, user: { id: userId, login: ghUser.login, avatarUrl: ghUser.avatar_url ?? null } });
});

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
