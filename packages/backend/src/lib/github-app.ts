/**
 * The platform's GitHub App (#258), Worker-native. Vendored from PAGS
 * (`workers/api/src/lib/github-app.ts`: `appJwt`, `mintInstallationToken`, the
 * encrypted token cache) — vendored, not depended on (stores/CLAUDE.md) — with
 * PAS's APP_SECRET_KEK envelope (lib/encryption.ts) in place of PAGS's crypto.ts.
 * PAGS's `verifyUserOwnsInstallation` is deliberately NOT vendored: it compares a
 * login string and accepts any org member. `proveInstallationControl` below is the
 * replacement, and never reads `users.login`.
 *
 * Not the GitHub OAuth *sign-in* app (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET,
 * routes/auth.ts): different registration, different names, never mixed.
 */
import type { Env } from '../types.js';
import { timingSafeEqual, toUint8 } from './bytes.js';
import { openSecret, sealSecret } from './encryption.js';

const GH_API = 'https://api.github.com';
const encoder = new TextEncoder();

/** Every connector route and token mint needs all of this; any gap is a 503, never a half-working flow. */
export function connectorConfigured(env: Env): boolean {
  return Boolean(
    env.GH_APP_ID && env.GH_APP_CLIENT_ID && env.GH_APP_SLUG && env.GH_APP_PRIVATE_KEY
    && env.GH_APP_WEBHOOK_SECRET && env.GH_APP_CLIENT_SECRET && env.APP_SECRET_KEK && env.SESSION_SIGNING_KEY,
  );
}

const ghHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'proappstore-connector/1.0',
});

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** A PEM PKCS#8 private key as importable bytes. (GitHub issues PKCS#1; convert before storing — issue #258 step 2.) */
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

/** A ~10-minute App JWT (RS256): the credential for App-level GitHub calls. */
export async function appJwt(env: Pick<Env, 'GH_APP_ID' | 'GH_APP_PRIVATE_KEY'>, now = Date.now()): Promise<string> {
  if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY) throw new Error('GitHub App not configured');
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(env.GH_APP_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sec = Math.floor(now / 1000);
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(encoder.encode(JSON.stringify({ iat: sec - 60, exp: sec + 540, iss: env.GH_APP_ID })));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

/** A fresh installation token (valid ~1 h). With `repo` GitHub itself scopes it: any other repo is refused at the credential. */
export async function mintInstallationToken(
  env: Pick<Env, 'GH_APP_ID' | 'GH_APP_PRIVATE_KEY'>, installationId: number, repo?: string,
): Promise<{ token: string; expiresAt: number } | null> {
  const jwt = await appJwt(env);
  const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: ghHeaders(jwt),
    // GitHub names repositories without the owner. Omitted entirely when unscoped: an empty array would mean "none".
    ...(repo ? { body: JSON.stringify({ repositories: [repo.split('/')[1]] }) } : {}),
  });
  if (!res.ok) return null;
  const data = await res.json() as { token?: string; expires_at?: string };
  const expiresAt = Date.parse(data.expires_at ?? '');
  return data.token && Number.isFinite(expiresAt) ? { token: data.token, expiresAt } : null;
}

export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * An installation token, from the encrypted cache until 5 minutes before expiry.
 * The cache key is (installation, scope): a token scoped to repo X is never handed
 * to a caller asking for Y, nor an unscoped token to one that asked for a scope.
 */
export async function installationToken(env: Env, installationId: number, repo?: string, now = Date.now()): Promise<string | null> {
  const kek = env.APP_SECRET_KEK;
  if (!kek) return null;
  const scope = repo ? repo.toLowerCase() : '';
  const row = await env.DB.prepare('SELECT token_ct, token_dek, token_iv, expires_at FROM github_installation_tokens WHERE installation_id = ? AND scope = ?')
    .bind(installationId, scope).first<{ token_ct: unknown; token_dek: unknown; token_iv: unknown; expires_at: number }>();
  if (row && row.expires_at - now > TOKEN_REFRESH_MARGIN_MS) {
    try {
      return await openSecret({ keyCiphertext: toUint8(row.token_ct), dekWrapped: toUint8(row.token_dek), iv: toUint8(row.token_iv) }, kek);
    } catch { /* unreadable (rotated KEK): mint a new one */ }
  }
  const minted = await mintInstallationToken(env, installationId, repo);
  if (!minted) return null;
  const sealed = await sealSecret(minted.token, kek);
  await env.DB.prepare(
    `INSERT INTO github_installation_tokens (installation_id, scope, token_ct, token_dek, token_iv, expires_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (installation_id, scope) DO UPDATE SET token_ct = excluded.token_ct, token_dek = excluded.token_dek, token_iv = excluded.token_iv, expires_at = excluded.expires_at`,
  ).bind(installationId, scope, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, minted.expiresAt).run();
  return minted.token;
}

// ── The signed `state` of the install round trip ─────────────────────────────

export const CONNECTOR_STATE_TTL_SECONDS = 600;

async function stateKey(sessionSigningKey: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', encoder.encode(sessionSigningKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('pas-connector-state') },
    ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  );
}

export interface ConnectorState { appId: string; userId: string; exp: number }

/** `state` = base64url({appId, userId, exp}) . base64url(HMAC): a key derived from SESSION_SIGNING_KEY, so no new secret and no confusion with a session token. */
export async function signConnectorState(env: Pick<Env, 'SESSION_SIGNING_KEY'>, appId: string, userId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.SESSION_SIGNING_KEY) throw new Error('SESSION_SIGNING_KEY is not configured');
  const body = b64url(encoder.encode(JSON.stringify({ appId, userId, exp: nowSeconds + CONNECTOR_STATE_TTL_SECONDS })));
  const mac = await crypto.subtle.sign('HMAC', await stateKey(env.SESSION_SIGNING_KEY), encoder.encode(body));
  return `${body}.${b64url(mac)}`;
}

/** The state if it is one we signed and has not expired; null otherwise. Constant-time compare. */
export async function verifyConnectorState(env: Pick<Env, 'SESSION_SIGNING_KEY'>, raw: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<ConnectorState | null> {
  if (!env.SESSION_SIGNING_KEY) return null;
  const [body, sig, extra] = raw.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = b64url(await crypto.subtle.sign('HMAC', await stateKey(env.SESSION_SIGNING_KEY), encoder.encode(body)));
  if (!timingSafeEqual(encoder.encode(sig), encoder.encode(expected))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Partial<ConnectorState>;
    if (typeof s.appId !== 'string' || typeof s.userId !== 'string' || typeof s.exp !== 'number' || s.exp <= nowSeconds) return null;
    return { appId: s.appId, userId: s.userId, exp: s.exp };
  } catch {
    return null;
  }
}

// ── Proving the user controls an installation (#258 §2) ──────────────────────

export interface GhInstallation { id: number; account: { id: number; login: string; type: string } }

/** The installation as the App sees it (App JWT); null if it does not exist. */
export async function getInstallation(env: Pick<Env, 'GH_APP_ID' | 'GH_APP_PRIVATE_KEY'>, installationId: number): Promise<GhInstallation | null> {
  const res = await fetch(`${GH_API}/app/installations/${installationId}`, { headers: ghHeaders(await appJwt(env)) });
  if (!res.ok) return null;
  const i = await res.json() as Partial<GhInstallation>;
  return typeof i.id === 'number' && i.account && typeof i.account.id === 'number' && typeof i.account.login === 'string'
    ? { id: i.id, account: { id: i.account.id, login: i.account.login, type: String(i.account.type ?? '') } }
    : null;
}

/** Exchange the install-time OAuth `code` for a user-to-server token. Used once, never stored. */
async function exchangeCode(env: Pick<Env, 'GH_APP_CLIENT_ID' | 'GH_APP_CLIENT_SECRET'>, code: string): Promise<string | null> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'proappstore-connector/1.0' },
    body: JSON.stringify({ client_id: env.GH_APP_CLIENT_ID, client_secret: env.GH_APP_CLIENT_SECRET, code }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null) as { access_token?: string } | null;
  return data?.access_token ?? null;
}

/** GET /user/installations: exactly the installations this GitHub user can access. */
async function userHasInstallation(userToken: string, installationId: number): Promise<boolean> {
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${GH_API}/user/installations?per_page=100&page=${page}`, { headers: ghHeaders(userToken) });
    if (!res.ok) return false;
    const data = await res.json() as { installations?: { id: number }[] };
    const list = data.installations ?? [];
    if (list.some((i) => i.id === installationId)) return true;
    if (list.length < 100) return false;
  }
  return false;
}

export type ControlProof = { ok: true } | { ok: false; error: string };
const deny = (error: string): ControlProof => ({ ok: false, error });
const REAUTHORIZE = 'reauthorize: reinstall or click Configure to re-run authorization';

/**
 * Whether this PAS user controls the installation. Never by login string, never by
 * plain org membership.
 *
 *  1. With the install-time `code`: exchange it for a user-to-server token and the
 *     installation must be in GET /user/installations (GitHub's own answer).
 *  2. Without one (e.g. "Redirect on update"): only a GitHub-signed-in PAS user, by
 *     the immutable numeric `users.provider_id` — a personal install's account id
 *     equals it; an org install needs an ACTIVE membership with role admin (read with
 *     an installation token; needs the App's Members: read permission).
 */
export async function proveInstallationControl(
  env: Env, user: { id: string }, installation: GhInstallation, code: string | null,
): Promise<ControlProof> {
  if (code) {
    const token = await exchangeCode(env, code);
    if (!token) return deny(REAUTHORIZE);
    return (await userHasInstallation(token, installation.id)) ? { ok: true } : deny('this GitHub user cannot access that installation');
  }
  const u = await env.DB.prepare('SELECT provider, provider_id FROM users WHERE id = ?').bind(user.id).first<{ provider: string; provider_id: string }>();
  if (!u || u.provider !== 'github' || !/^\d+$/.test(u.provider_id)) return deny('sign in with GitHub to connect an installation');
  if (installation.account.type !== 'Organization') {
    return installation.account.id === Number(u.provider_id) ? { ok: true } : deny('this installation belongs to a different GitHub account');
  }
  const token = await mintInstallationToken(env, installation.id);
  if (!token) return deny(REAUTHORIZE);
  const who = await fetch(`${GH_API}/user/${u.provider_id}`, { headers: ghHeaders(token.token) });
  const login = who.ok ? (await who.json() as { login?: string }).login : undefined;
  if (!login) return deny(REAUTHORIZE);
  const m = await fetch(`${GH_API}/orgs/${encodeURIComponent(installation.account.login)}/memberships/${encodeURIComponent(login)}`, { headers: ghHeaders(token.token) });
  const membership = m.ok ? await m.json() as { state?: string; role?: string } : null;
  if (membership?.state === 'active' && membership.role === 'admin') return { ok: true };
  return deny(REAUTHORIZE);
}
