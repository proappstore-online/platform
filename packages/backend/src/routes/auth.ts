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

import { APP_CONTEXT_HEADER } from '../lib/app-context.js';
import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { mintSession, verifySession, type NewSession, type SessionClaims } from '@proappstore/build-core';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';
import { hashPassword, verifyPassword, dummyPasswordHash } from '../lib/password.js';
import { prepareActionQuery, type ToolManifest } from '../lib/action-sql.js';
import {
  generateLogin, generatePassword, normalizeLogin, isValidLogin,
  normalizeEmail, isValidEmail, looksLikeEmail,
} from '../lib/credential-gen.js';
import { d1AttemptStore, isBlocked, recordFailure, recordSuccess } from '../lib/credential-rate-limit.js';
import { recordAuthFailure, recordOperationFailure } from '../lib/operation-log.js';

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

function validAppId(appId: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(appId) && appId.length <= 58;
}

function appIdFromBody(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const appId = value.trim();
  return validAppId(appId) ? appId : null;
}

async function appActionAllows(
  c: Context<{ Bindings: Env }>,
  appId: string,
  actionName: string,
  params: Record<string, unknown>,
  userId: string,
): Promise<boolean> {
  if (!validAppId(appId)) return false;

  const row = await c.env.DB.prepare('SELECT manifest FROM app_tools WHERE app_id = ? AND name = ?')
    .bind(appId, actionName)
    .first<{ manifest: string }>();
  if (!row) return false;

  let manifest: ToolManifest;
  try {
    manifest = JSON.parse(row.manifest) as ToolManifest;
  } catch {
    return false;
  }
  if (manifest.operation !== 'query') return false;

  let payload: { sql: string; params: unknown[] };
  try {
    payload = prepareActionQuery(manifest, params, userId);
  } catch {
    return false;
  }

  const upstream = await fetch(`https://data-${appId}.proappstore.online/query`, {
    method: 'POST',
    headers: {
      ...(c.env.INTERNAL_TOKEN ? { 'X-Internal-Token': c.env.INTERNAL_TOKEN } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!upstream?.ok) return false;

  const data = await upstream.json().catch(() => null) as { rows?: unknown[] } | null;
  return Array.isArray(data?.rows) && data.rows.length > 0;
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
  };
}

/** Cookie that binds the OAuth `state` to the initiating browser (CSRF guard). */
// __Host- prefix (#88): forces Secure + Path=/ + no Domain, so a sibling
// *.proappstore.online app can't overwrite it (cookie-tossing the CSRF state).
const STATE_COOKIE = '__Host-pas_oauth_state';

type Provider = 'github' | 'google';
const PROVIDERS = new Set<Provider>(['github', 'google']);

interface Profile { providerId: string; login: string; email: string | null; avatarUrl: string | null }

type OAuthState = {
  r?: string;
  m?: string;
  n?: string;
  a?: string;
};

function platformReturnToAllowed(u: URL): boolean {
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    || u.hostname === 'proappstore.online' || u.hostname.endsWith('.proappstore.online')
    || u.hostname === 'proideastore.online' || u.hostname.endsWith('.proideastore.online');
}

/** Apex domains of first-party PAS surfaces. */
const FIRST_PARTY_APEXES = new Set(['proappstore.online', 'proideastore.online']);
/** Reserved subdomains that are first-party platform SPAs (NOT creator-controlled apps). */
const FIRST_PARTY_SUBDOMAINS = new Set(['console', 'dashboard', 'admin', 'agents']);

/**
 * SECURITY (#56): true only for trusted first-party PAS surfaces — the apex
 * store, console/dashboard/admin/agents, and localhost. Every `<app>.proappstore.online`
 * app subdomain and BYO custom domain is creator-controlled and returns FALSE,
 * so those origins never receive a token carrying platform `creator`/`admin`.
 */
export function isFirstPartyHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (FIRST_PARTY_APEXES.has(h)) return true;
  const dot = h.indexOf('.');
  if (dot > 0) {
    const sub = h.slice(0, dot);
    const apex = h.slice(dot + 1);
    if (FIRST_PARTY_APEXES.has(apex) && FIRST_PARTY_SUBDOMAINS.has(sub)) return true;
  }
  return false;
}

async function activeCustomDomainAllowed(env: Env, appId: string | undefined, hostname: string): Promise<boolean> {
  if (!appId) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const firstDot = host.indexOf('.');
  const wildcardBase = firstDot > 0 ? host.slice(firstDot + 1) : '';

  const exactOrWildcardBase = await env.DB.prepare(
    `SELECT 1 FROM app_custom_domains
     WHERE app_id = ?1 AND domain = ?2 AND status = 'active'
     LIMIT 1`,
  ).bind(appId, host).first();
  if (exactOrWildcardBase) return true;
  if (!wildcardBase) return false;

  const wildcard = await env.DB.prepare(
    `SELECT 1 FROM app_custom_domains
     WHERE app_id = ?1 AND domain = ?2 AND COALESCE(kind, 'exact') = 'wildcard' AND status = 'active'
     LIMIT 1`,
  ).bind(appId, wildcardBase).first();
  return Boolean(wildcard);
}

/** return_to must be one of our own origins — prevents the callback becoming an open redirect. */
async function returnToAllowed(env: Env, url: string, appId?: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return false;
    if (platformReturnToAllowed(u)) return true;
    if (u.protocol !== 'https:') return false;
    return activeCustomDomainAllowed(env, appId, u.hostname);
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

// ── One-time login codes (#87, #110) ──────────────────────────────────────
//
// A session JWT handed back as `?session=` reaches servers: CDN logs, Referer
// headers, browser history — and it is a directly reusable Bearer. These codes
// replace that with a value the browser carries but cannot use, redeemed
// server-to-server at POST /v1/auth/code/exchange.

/** Codes live just long enough to survive a redirect and a POST. */
const EXCHANGE_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Mint a one-time login code for `claims` and store only its hash.
 *
 * 32 random bytes, hex — 256 bits, well past guessing, and the value is
 * meaningless without the row it unlocks. (UUIDv4 would be 122 bits and carries
 * version/variant structure; there is no reason to be that close to the line
 * for a credential that appears in a URL.)
 *
 * Claims are decided HERE, at redirect time, not at exchange time. The #56 role
 * decision depends on the destination host — an app origin gets a plain
 * ['user'] token — and the exchange endpoint cannot see where the browser was
 * headed. Deciding roles later would silently re-privilege app-origin sessions
 * and undo that fix.
 *
 * Stores claims rather than a minted token, so nothing signable-into-a-session
 * exists at rest and an unexchanged code produces no session at all.
 */
async function issueExchangeCode(
  db: D1Database,
  claims: NewSession,
  nowMs: number,
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let code = '';
  for (const byte of bytes) code += byte.toString(16).padStart(2, '0');

  await db
    .prepare(
      'INSERT INTO auth_exchange_codes (code_hash, claims, expires_at, created_at) VALUES (?, ?, ?, ?)',
    )
    .bind(await hashExchangeCode(code), JSON.stringify(claims), nowMs + EXCHANGE_CODE_TTL_MS, nowMs)
    .run();

  return code;
}

/** SHA-256, base64url. Codes are stored hashed so the table holds nothing usable. */
async function hashExchangeCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * POST /v1/auth/code/exchange — redeem a one-time login code for a session.
 *
 * NOT on `/v1/auth/exchange`: that path is already the GitHub device-token
 * exchange (hardened for #84), and a second handler there would shadow it.
 *
 * Fail-closed and uniform: missing, malformed, unknown, expired and
 * already-used all return the same bare 400. A presented code is consumed
 * whether or not it was valid, so a guess cannot be retried, and the row is
 * deleted before the session is minted so a race cannot yield two sessions
 * from one code.
 */
authRoutes.post('/auth/code/exchange', async (c) => {
  let code = '';
  try {
    const body = await c.req.json<{ code?: unknown }>();
    if (typeof body?.code === 'string') code = body.code;
  } catch {
    /* handled by the empty check */
  }
  if (!code) return c.json({ error: 'invalid code' }, 400);

  const codeHash = await hashExchangeCode(code);
  const now = Date.now();

  const row = await c.env.DB.prepare(
    'SELECT claims FROM auth_exchange_codes WHERE code_hash = ? AND expires_at > ?',
  )
    .bind(codeHash, now)
    .first<{ claims: string }>();

  // Consume unconditionally — before validating, and whether or not anything
  // was found. A wrong guess must not be retryable, and an expired row must not
  // linger.
  await c.env.DB.prepare('DELETE FROM auth_exchange_codes WHERE code_hash = ?')
    .bind(codeHash)
    .run()
    .catch(() => { /* the read already decided the outcome */ });

  if (!row) return c.json({ error: 'invalid code' }, 400);

  let claims: NewSession;
  try {
    claims = JSON.parse(row.claims) as NewSession;
  } catch {
    return c.json({ error: 'invalid code' }, 400);
  }
  if (!claims?.uid) return c.json({ error: 'invalid code' }, 400);

  const token = await mintSession(claims, c.env.SESSION_SIGNING_KEY);
  return c.json({ token });
});

// ── GET /v1/auth/:provider/start ───────────────────────────
authRoutes.get('/auth/:provider/start', async (c) => {
  const provider = c.req.param('provider') as Provider;
  if (!PROVIDERS.has(provider)) return c.text('unknown provider', 404);

  const clientId = provider === 'github' ? c.env.GITHUB_CLIENT_ID : c.env.GOOGLE_CLIENT_ID;
  if (!clientId) return c.text(`${provider} sign-in is not configured`, 503);

  const returnTo = c.req.query('return_to') || '';
  const appId = c.req.query('app_id') || undefined;
  if (!(await returnToAllowed(c.env, returnTo, appId))) return c.text('invalid return_to', 400);
  const responseMode = c.req.query('response_mode') === 'query' ? 'query' : 'fragment';

  const state = btoa(JSON.stringify({ r: returnTo, m: responseMode, n: crypto.randomUUID(), a: appId }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Bind the state to this browser so the callback can reject forged/replayed
  // states (login CSRF). SameSite=Lax survives the top-level OAuth redirect back.
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
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
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });
  if (!cookieState || cookieState !== stateRaw) return c.text('invalid state', 400);

  // Recover the (own-origin) return_to from the verified state first, so any
  // later failure can bounce the user back to the app with a clean error
  // instead of a bare error page.
  let returnTo = '';
  let appId: string | undefined;
  let responseMode: 'fragment' | 'query' = 'fragment';
  try {
    const b64 = stateRaw.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const parsed = JSON.parse(json) as OAuthState;
    returnTo = parsed.r || '';
    appId = parsed.a || undefined;
    if (parsed.m === 'query') responseMode = 'query';
  } catch { /* fall through to validation */ }
  if (!(await returnToAllowed(c.env, returnTo, appId))) return c.text('invalid state', 400);

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

    const dest = new URL(returnTo);
    // SECURITY (#56): a session delivered to an app origin (any app subdomain or
    // BYO custom domain — JS the creator controls) must NOT carry platform
    // `creator`/`admin`. Otherwise a creator could phish a victim through the
    // legitimate API and capture (or drive, via cookie mediation) a
    // platform-privileged token. App + team access is derived server-side from
    // the DB (team_members / app_roles), NOT from these platform roles, so apps
    // keep working with a plain `user` token. Only first-party PAS surfaces
    // (console/dashboard/admin/agents/apex/localhost) receive elevated roles.
    const roles = isFirstPartyHost(dest.hostname) ? rolesFor(userId, c.env) : ['user'];
    const claims: NewSession = { uid: userId, login: profile.login, avatarUrl: profile.avatarUrl, roles };

    // SECURITY (#87, #110): `query` no longer means "the token, in the query
    // string". It means "a one-time code, redeemed server-to-server". A query
    // parameter reaches servers — CDN and edge access logs, Referer headers,
    // browser history — and the old `?session=` value was a directly reusable
    // Bearer for the life of the session.
    //
    // The parameter itself has to stay. It is the only signal separating a
    // server-side callback (the host worker and the MCP provider, which can
    // redeem a code over HTTP) from a browser SPA (which reads the fragment in
    // JS). Removing it would either break those two flows or force every app's
    // SDK onto a fragment-based code exchange — a contract change for the whole
    // fleet, not a security fix.
    //
    // The fragment branch is unchanged: fragments are never sent to servers, so
    // they were never the leak this addresses.
    if (responseMode === 'query') {
      dest.searchParams.set('code', await issueExchangeCode(c.env.DB, claims, Date.now()));
    } else {
      const token = await mintSession(claims, c.env.SESSION_SIGNING_KEY);
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
// An authenticated adult (creator) or app-authorized staff member provisions a
// child/student account that
// signs in with a username + password — no email, no OAuth. Returns the
// login + password ONCE (the password is never retrievable again). Built for
// kids who don't have email (chess-academy); generalizes to any education
// product. This is NOT public self-registration — provisioning is gated.
authRoutes.post('/auth/credentials/provision', async (c) => {
  const claims = await requireClaims(c);
  const body = await c.req
    .json<{ login?: string; email?: string; displayName?: string; isChild?: boolean; password?: string; appId?: string; orgId?: string; schoolId?: string | null }>()
    .catch(() => ({} as { login?: string; email?: string; displayName?: string; isChild?: boolean; password?: string; appId?: string; orgId?: string; schoolId?: string | null }));

  const platformAllowed = claims.roles.includes('creator') || claims.roles.includes('admin');
  if (!platformAllowed) {
    const appId = appIdFromBody(body.appId);
    const appAllowed = appId
      ? await appActionAllows(c, appId, 'can_provision_student_credentials', {
        org_id: body.orgId,
        school_id: body.schoolId ?? null,
      }, claims.uid)
      : false;
    if (!appAllowed) {
      // Instrumented explicitly rather than via the central onError hook: appId
      // arrives in the *body* here, not the path, so the hook cannot see it.
      //
      // This is the Chess Academy failure — staff hit "Only creators..." during a
      // student credential flow and nothing anywhere recorded it, so it had to be
      // diagnosed by reading source. With this row, the console answers it:
      // which app, which user, which operation, which status.
      if (appId) {
        await recordOperationFailure(c.env, {
          appId,
          userId: claims.uid,
          method: 'POST',
          routePath: '/v1/auth/credentials/provision',
          params: { name: 'provisionChild' },
          status: 403,
          message: 'not allowed to provision credential accounts',
          traceId: c.req.header('traceparent')?.split('-')[1] ?? null,
          cfRay: c.req.header('cf-ray') ?? null,
          mediated: Boolean(c.req.header(APP_CONTEXT_HEADER)),
        });
      }
      throw new HttpError('not allowed to provision credential accounts', 403);
    }
  }

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

  // Optional second sign-in identifier, for adults provisioned without OAuth
  // (0042). Never verified — we send nothing to it — so it identifies the row
  // and the password still does all the proving.
  let credentialEmail: string | null = null;
  const emailSupplied = body.email !== undefined && body.email !== null && String(body.email).trim() !== '';
  if (emailSupplied) {
    if (typeof body.email !== 'string') throw new HttpError('email must be a string', 400);
    // `isChild` defaults to true, so attaching an email is opt-in twice over:
    // the caller must pass both `email` and `isChild: false`. That is the point
    // — 0029 makes "no email, no real name" the COPPA privacy feature for child
    // accounts, and silently storing a child's address would undo it.
    if (isChild) throw new HttpError('email is not allowed on a child account — pass isChild: false', 400);
    credentialEmail = normalizeEmail(body.email);
    if (!isValidEmail(credentialEmail)) throw new HttpError('email must be a valid address', 400);
  }

  const now = Date.now();

  const attempts = supplied ? 1 : 6;
  for (let i = 0; i < attempts; i++) {
    const login = supplied ? suppliedLogin : generateLogin();
    const uid = `cred:${crypto.randomUUID()}`;
    const display = (body.displayName ?? '').trim() || login;
    try {
      // `email` (the OAuth column, 0021) stays NULL on purpose: it means "an
      // identity provider vouched for this address", which is never true here.
      // A provisioned address goes in credential_email and nowhere else.
      await c.env.DB.prepare(
        `INSERT INTO users (id, provider, provider_id, login, email, avatar_url, is_child,
           credential_login, credential_email, password_hash, created_by, created_at, last_login_at)
         VALUES (?1, 'credential', ?1, ?2, NULL, NULL, ?3, ?4, ?8, ?5, ?6, ?7, ?7)`,
      ).bind(uid, display, isChild ? 1 : 0, login, passwordHash, claims.uid, now, credentialEmail).run();

      // Returned ONCE — the password is not stored in plaintext and can't be
      // fetched again. If lost, the adult re-provisions / resets.
      return c.json({ uid, login, email: credentialEmail, password, isChild });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const isUnique = /UNIQUE constraint failed/i.test(message);
      // An email collision must NOT fall through to the retry below: the loop
      // only re-rolls the login, so the same email would collide all six times
      // and surface a 503 ("could not generate a unique login") for what is
      // really a 409 the caller can act on.
      if (isUnique && /credential_email/i.test(message)) {
        throw new HttpError('that email is already taken', 409);
      }
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
//
// The `login` field takes either an animal-triple username or, for an adult
// account provisioned with one, an email (0042). Both resolve to the same row
// and the same session; the password check is unchanged.
authRoutes.post('/auth/credentials/login', async (c) => {
  const body = await c.req
    .json<{ login?: string; password?: string }>()
    .catch(() => ({} as { login?: string; password?: string }));
  const raw = typeof body.login === 'string' ? body.login : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!raw.trim() || !password) throw new HttpError('login and password are required', 400);

  // One request field, two identifier spaces (0042). '@' decides, and it can't
  // be ambiguous: isValidLogin rejects '@' and isValidEmail requires one, so
  // the spaces are disjoint by construction.
  const byEmail = looksLikeEmail(raw);
  const login = byEmail ? normalizeEmail(raw) : normalizeLogin(raw);

  // Reject a malformed identifier before touching D1. Two reasons: the format
  // rules are public, so this reveals nothing about which accounts exist; and
  // `credential_login_attempts.login` is the PRIMARY KEY, so without this an
  // unauthenticated caller can insert an unbounded number of junk rows by
  // failing once against each of a million made-up identifiers. Every stored
  // credential_login passed isValidLogin at provision time and every
  // credential_email passed isValidEmail, so no real account is shut out.
  // Same 401 and same message as a wrong password — one failure surface.
  if (byEmail ? !isValidEmail(login) : !isValidLogin(login)) {
    throw new HttpError('invalid login or password', 401);
  }

  const store = d1AttemptStore(c.env.DB);
  const now = Date.now();
  // Keyed on the identifier as typed, so an account with both a username and
  // an email has two independent counters and tolerates 2 × MAX_ATTEMPTS
  // guesses overall. Accepted: only adults (isChild: false) can hold an email,
  // and provisioning an adult account is where a caller-chosen password is
  // realistic, so the doubled budget applies to the accounts least likely to
  // carry a low-entropy animal password. Key on the resolved user id instead
  // if that stops being true.
  if (await isBlocked(store, login, now)) {
    // Counted, never stored: a credential sign-in is not app-scoped and
    // `app_logs.app_id` is NOT NULL, so this lands in Analytics Engine under the
    // `platform` index. It is the only visibility we have into platform#89 —
    // lockout is per-login, so a known login can be locked out by a third party
    // and today nothing records the pattern. No login or password material is
    // included, only the reason.
    await recordAuthFailure(c.env, {
      reason: 'lockout',
      status: 429,
      cfRay: c.req.header('cf-ray') ?? null,
    });
    throw new HttpError('too many sign-in attempts — please try again later', 429);
  }

  // Two statements rather than `WHERE credential_login = ?1 OR credential_email = ?1`:
  // each hits its own partial unique index, and neither can cross-match into
  // the other column.
  const row = await c.env.DB.prepare(
    byEmail
      ? 'SELECT id, login, password_hash FROM users WHERE credential_email = ?'
      : 'SELECT id, login, password_hash FROM users WHERE credential_login = ?',
  ).bind(login).first<{ id: string; login: string; password_hash: string | null }>();

  // Always run one PBKDF2 pass — against a fixed dummy hash when the login (or
  // its hash) is absent — so response timing doesn't reveal whether the account
  // exists (user enumeration). `ok` still requires a real matching row.
  const passwordMatches = await verifyPassword(password, row?.password_hash ?? (await dummyPasswordHash()));
  const ok = !!row?.password_hash && passwordMatches;
  if (!ok || !row) {
    await recordFailure(store, login, now);
    // One reason for both branches, matching the response: distinguishing
    // "no such login" from "wrong password" in telemetry would reintroduce the
    // account enumeration the constant-time path above exists to prevent, for
    // anyone who can read the metrics.
    await recordAuthFailure(c.env, {
      reason: 'invalid_credentials',
      status: 401,
      cfRay: c.req.header('cf-ray') ?? null,
    });
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
// An authenticated adult or app-authorized staff member resets the password of
// a credential (child) account. Returns the new random password ONCE — the
// adult shows it to the child.
authRoutes.post('/auth/credentials/reset-password', async (c) => {
  const claims = await requireClaims(c);
  const body = await c.req
    .json<{ targetUserId?: string; appId?: string }>()
    .catch(() => ({} as { targetUserId?: string; appId?: string }));
  const targetId = body.targetUserId;
  if (!targetId || typeof targetId !== 'string') throw new HttpError('targetUserId is required', 400);
  if (!targetId.startsWith('cred:')) throw new HttpError('can only reset credential accounts', 400);

  const appId = appIdFromBody(body.appId);
  const appAllowed = appId
    ? await appActionAllows(c, appId, 'can_reset_student_credential_password', {
      target_user_id: targetId,
    }, claims.uid)
    : false;
  if (!appAllowed && !claims.roles.includes('creator') && !claims.roles.includes('admin')) {
    throw new HttpError('not allowed to reset credential passwords', 403);
  }

  // Verify the target exists and is a credential account
  const target = await c.env.DB.prepare(
    'SELECT id, credential_login, created_by FROM users WHERE id = ? AND provider = ?',
  ).bind(targetId, 'credential').first<{ id: string; credential_login: string; created_by: string | null }>();
  if (!target) throw new HttpError('account not found', 404);

  // SECURITY: only the adult who created this credential account (or an admin)
  // may reset its password. Without this, every 'creator' (which is every
  // signed-in user) could reset ANY credential account and read the new
  // password from the response — full cross-tenant account takeover.
  if (!appAllowed && target.created_by !== claims.uid && !claims.roles.includes('admin')) {
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

  // SECURITY (#84): verify the token was issued to OUR OAuth app, not merely
  // that it's a valid GitHub token. Otherwise a token minted for any other
  // OAuth app — or a leaked PAT — could be exchanged for a full PAS session
  // (confused-deputy / audience confusion). GitHub's app-authenticated
  // check-token endpoint returns 200 + the token's user only when the token
  // belongs to `client_id`, else 404.
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.text('token exchange is not configured', 503);
  }
  const introRes = await fetch(`https://api.github.com/applications/${c.env.GITHUB_CLIENT_ID}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${c.env.GITHUB_CLIENT_ID}:${c.env.GITHUB_CLIENT_SECRET}`)}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'proappstore-api',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: githubToken }),
  });
  if (introRes.status !== 200) return c.text('github token was not issued to this application', 401);
  const intro = (await introRes.json()) as {
    user?: { id: number; login: string; avatar_url?: string; email?: string | null };
  };
  const ghUser = intro.user;
  if (!ghUser) return c.text('invalid github token', 401);

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
