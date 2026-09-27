/**
 * Passkey (WebAuthn) step-up (#230, part of #228).
 *
 * A signed-in user registers a passkey on an app origin, then re-authenticates
 * with it before privileged work. A verified step-up returns a new session that
 * carries `auth_time = now`, `auth_method = 'passkey'` and a short life
 * (STEP_UP_SESSION_TTL_SECONDS). The host swaps it into the HttpOnly cookie
 * (`/.pas/auth/passkey/*`), so page JS never sees a token.
 *
 * Reachable only through the host's mediation: the relying-party id is the app
 * hostname the host asserts in `X-PAS-Host`, which a direct caller cannot set.
 *
 * Registration uses `attestation: 'none'`. The browser sends the SPKI public key
 * (`AuthenticatorAttestationResponse.getPublicKey()`), so there is no CBOR to
 * parse. That key is only trusted because the registering session is freshly
 * authenticated (see requireFreshForRegistration): a stolen long-lived cookie
 * must not be able to enroll the thief's own passkey and then step up with it.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { mintSession, type NewSession, type SessionClaims } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';
import { APP_CONTEXT_HEADER, APP_HOST_HEADER } from '../lib/app-context.js';
import { requireClaims } from './auth.js';

export const passkeyRoutes = new Hono<{ Bindings: Env }>();

/** Life of the session a passkey step-up issues. */
export const STEP_UP_SESSION_TTL_SECONDS = 60 * 60;
/** How recent a sign-in must be to register a passkey. */
export const FRESH_AUTH_SECONDS = 10 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5 * 60 * 1000;

/** COSE algorithm ids we verify. */
const ES256 = -7;
const RS256 = -257;

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified (PIN / biometric) — the second factor
const FLAG_AT = 0x40; // attested credential data included

const enc = new TextEncoder();
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// ── helpers ──────────────────────────────────────────────────────

function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || !value) throw new HttpError(`${field} must be base64url`, 400);
  const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The relying party: the app hostname the host mediated this request from. */
function relyingParty(c: Context<{ Bindings: Env }>): { appId: string; rpId: string } {
  const appId = c.req.header(APP_CONTEXT_HEADER);
  const rpId = c.req.header(APP_HOST_HEADER)?.toLowerCase();
  if (!appId || !rpId || !HOSTNAME.test(rpId)) throw new HttpError('passkeys are only available on an app origin', 400);
  return { appId, rpId };
}

async function credentialIds(db: D1Database, userId: string, rpId: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT id FROM passkey_credentials WHERE user_id = ?1 AND rp_id = ?2').bind(userId, rpId).all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

/**
 * Registering needs a recent sign-in; once the user has a passkey here, adding
 * another needs a recent passkey step-up. Sessions without `auth_time` (minted
 * before #230) are never fresh.
 */
function reauthRequired(claims: SessionClaims, hasPasskey: boolean): string | null {
  const fresh = typeof claims.auth_time === 'number' && nowSeconds() - claims.auth_time <= FRESH_AUTH_SECONDS;
  if (hasPasskey) return fresh && claims.auth_method === 'passkey' ? null : 'adding another passkey requires a passkey step-up first';
  return fresh ? null : 'sign in again to add a passkey';
}

async function issueChallenge(db: D1Database, userId: string, rpId: string, purpose: 'register' | 'step-up'): Promise<string> {
  const challenge = toB64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM passkey_challenges WHERE user_id = ?1 AND expires_at < ?2').bind(userId, now),
    db.prepare('INSERT INTO passkey_challenges (challenge, user_id, rp_id, purpose, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(challenge, userId, rpId, purpose, now + CHALLENGE_TTL_MS),
  ]);
  return challenge;
}

/**
 * Check clientDataJSON and consume its challenge (one use, whatever the outcome).
 * Returns the clientDataJSON bytes for signature verification.
 */
async function verifyClientData(
  db: D1Database,
  raw: unknown,
  expected: { type: 'webauthn.create' | 'webauthn.get'; userId: string; rpId: string; purpose: 'register' | 'step-up' },
): Promise<Uint8Array> {
  const bytes = fromB64url(raw, 'clientDataJSON');
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError('clientDataJSON is not JSON', 400);
  }
  if (typeof data.challenge !== 'string') throw new HttpError('clientDataJSON has no challenge', 400);
  const row = await db
    .prepare('DELETE FROM passkey_challenges WHERE challenge = ?1 AND user_id = ?2 AND rp_id = ?3 AND purpose = ?4 RETURNING expires_at')
    .bind(data.challenge, expected.userId, expected.rpId, expected.purpose)
    .first<{ expires_at: number }>();
  if (!row || row.expires_at < Date.now()) throw new HttpError('unknown or expired challenge', 400);
  if (data.type !== expected.type) throw new HttpError(`clientDataJSON type must be ${expected.type}`, 400);
  if (data.origin !== `https://${expected.rpId}`) throw new HttpError('origin does not match this app', 400);
  if (data.crossOrigin === true) throw new HttpError('cross-origin ceremonies are not accepted', 400);
  return bytes;
}

/** Check rpIdHash and the UP + UV flags; return the flags and the signature counter. */
async function verifyAuthenticatorData(authData: Uint8Array, rpId: string): Promise<{ flags: number; signCount: number }> {
  if (authData.length < 37) throw new HttpError('authenticatorData is too short', 400);
  if (!equalBytes(authData.slice(0, 32), await sha256(enc.encode(rpId)))) throw new HttpError('authenticatorData is for another relying party', 400);
  const flags = authData[32]!;
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) throw new HttpError('the passkey must verify the user (PIN or biometric)', 400);
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  return { flags, signCount };
}

async function importPublicKey(spki: Uint8Array, alg: number): Promise<CryptoKey> {
  const params = alg === ES256
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  return crypto.subtle.importKey('spki', spki as BufferSource, params, false, ['verify']);
}

/** WebAuthn ES256 signatures are DER; WebCrypto wants raw r||s (32 bytes each). */
function derToRawEcdsa(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new HttpError('malformed ES256 signature', 400);
  let offset = 2;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[offset] !== 0x02) throw new HttpError('malformed ES256 signature', 400);
    const len = der[offset + 1]!;
    let int = der.slice(offset + 2, offset + 2 + len);
    while (int.length > 32 && int[0] === 0) int = int.slice(1);
    if (int.length > 32) throw new HttpError('malformed ES256 signature', 400);
    out.set(int, part * 32 + (32 - int.length));
    offset += 2 + len;
  }
  return out;
}

async function verifySignature(publicKey: string, alg: number, signature: Uint8Array, signed: Uint8Array): Promise<boolean> {
  const key = await importPublicKey(fromB64url(publicKey, 'publicKey'), alg);
  if (alg === ES256) return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRawEcdsa(signature) as BufferSource, signed as BufferSource);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, signed as BufferSource);
}

// ── registration ─────────────────────────────────────────────────

passkeyRoutes.post('/auth/passkey/register/options', async (c) => {
  const claims = await requireClaims(c);
  const { appId, rpId } = relyingParty(c);
  const existing = await credentialIds(c.env.DB, claims.uid, rpId);
  const refusal = reauthRequired(claims, existing.length > 0);
  if (refusal) return c.json({ error: refusal, code: 'reauth_required' }, 403);

  const challenge = await issueChallenge(c.env.DB, claims.uid, rpId, 'register');
  const name = claims.login ?? claims.uid;
  return c.json({
    challenge,
    rp: { id: rpId, name: appId },
    user: { id: toB64url(enc.encode(claims.uid)), name, displayName: name },
    pubKeyCredParams: [{ type: 'public-key', alg: ES256 }, { type: 'public-key', alg: RS256 }],
    timeout: TIMEOUT_MS,
    attestation: 'none',
    authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
    excludeCredentials: existing.map((id) => ({ type: 'public-key', id })),
  });
});

passkeyRoutes.post('/auth/passkey/register', async (c) => {
  const claims = await requireClaims(c);
  const { rpId } = relyingParty(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const existing = await credentialIds(c.env.DB, claims.uid, rpId);
  const refusal = reauthRequired(claims, existing.length > 0);
  if (refusal) return c.json({ error: refusal, code: 'reauth_required' }, 403);

  await verifyClientData(c.env.DB, body.clientDataJSON, { type: 'webauthn.create', userId: claims.uid, rpId, purpose: 'register' });
  const authData = fromB64url(body.authenticatorData, 'authenticatorData');
  const { flags, signCount } = await verifyAuthenticatorData(authData, rpId);
  if (!(flags & FLAG_AT) || authData.length < 55) throw new HttpError('authenticatorData carries no credential', 400);
  const idLength = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0);
  const credentialId = authData.slice(55, 55 + idLength);
  if (credentialId.length !== idLength || !equalBytes(credentialId, fromB64url(body.id, 'id'))) {
    throw new HttpError('credential id does not match authenticatorData', 400);
  }

  const alg = body.publicKeyAlgorithm;
  if (alg !== ES256 && alg !== RS256) throw new HttpError('publicKeyAlgorithm must be -7 (ES256) or -257 (RS256)', 400);
  const publicKey = body.publicKey;
  try {
    await importPublicKey(fromB64url(publicKey, 'publicKey'), alg);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError('publicKey is not a valid SPKI key for publicKeyAlgorithm', 400);
  }

  const id = toB64url(credentialId);
  const inserted = await c.env.DB
    .prepare(
      `INSERT INTO passkey_credentials (id, user_id, rp_id, public_key, alg, sign_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, claims.uid, rpId, publicKey as string, alg, signCount, Date.now())
    .run();
  if (!inserted.meta.changes) return c.json({ error: 'this passkey is already registered' }, 409);
  return c.json({ ok: true, id });
});

// ── step-up ──────────────────────────────────────────────────────

passkeyRoutes.post('/auth/passkey/step-up/options', async (c) => {
  const claims = await requireClaims(c);
  const { rpId } = relyingParty(c);
  const ids = await credentialIds(c.env.DB, claims.uid, rpId);
  if (!ids.length) return c.json({ error: 'no passkey registered for this app', code: 'no_passkey' }, 404);
  const challenge = await issueChallenge(c.env.DB, claims.uid, rpId, 'step-up');
  return c.json({
    challenge,
    rpId,
    timeout: TIMEOUT_MS,
    userVerification: 'required',
    allowCredentials: ids.map((id) => ({ type: 'public-key', id })),
  });
});

passkeyRoutes.post('/auth/passkey/step-up', async (c) => {
  const claims = await requireClaims(c);
  const { rpId } = relyingParty(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.id !== 'string') throw new HttpError('id is required', 400);
  const cred = await c.env.DB
    .prepare('SELECT id, public_key, alg, sign_count FROM passkey_credentials WHERE id = ?1 AND user_id = ?2 AND rp_id = ?3')
    .bind(body.id, claims.uid, rpId)
    .first<{ id: string; public_key: string; alg: number; sign_count: number }>();
  if (!cred) throw new HttpError('unknown passkey', 400);

  const clientData = await verifyClientData(c.env.DB, body.clientDataJSON, { type: 'webauthn.get', userId: claims.uid, rpId, purpose: 'step-up' });
  const authData = fromB64url(body.authenticatorData, 'authenticatorData');
  const { signCount } = await verifyAuthenticatorData(authData, rpId);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(await sha256(clientData), authData.length);
  if (!(await verifySignature(cred.public_key, cred.alg, fromB64url(body.signature, 'signature'), signed))) {
    throw new HttpError('passkey signature is invalid', 403);
  }
  // A counter that stops increasing means a cloned authenticator; authenticators
  // that do not count report 0 every time.
  if ((signCount !== 0 || cred.sign_count !== 0) && signCount <= cred.sign_count) {
    throw new HttpError('passkey signature counter went backwards', 403);
  }
  await c.env.DB.prepare('UPDATE passkey_credentials SET sign_count = ?1, last_used_at = ?2 WHERE id = ?3').bind(signCount, Date.now(), cred.id).run();

  const { iat: _iat, exp: _exp, ...rest } = claims;
  const authTime = nowSeconds();
  const next: NewSession = { ...rest, auth_time: authTime, auth_method: 'passkey' };
  const token = await mintSession(next, c.env.SESSION_SIGNING_KEY, STEP_UP_SESSION_TTL_SECONDS);
  return c.json({ token, auth_time: authTime, expires_at: authTime + STEP_UP_SESSION_TTL_SECONDS });
});
