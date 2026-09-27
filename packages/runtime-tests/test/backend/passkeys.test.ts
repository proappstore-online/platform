import { SELF, env } from 'cloudflare:test';
import { mintSession, verifySession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE } from './helpers';

// #230 (part of #228): passkey registration and step-up on real D1 and real
// WebCrypto. The "authenticator" is a P-256 key made here, producing the exact
// bytes a browser would: clientDataJSON, authenticatorData, a DER signature.

const RP = 'demo.proappstore.online';
const ORIGIN = `https://${RP}`;
const UID = 'gh:7';
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

const b64url = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** Raw r||s → DER, as authenticators encode ES256 signatures. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const v = x.slice(i);
    return v[0]! & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
}

/** A session like the backend mints at sign-in. */
function signIn(opts: { authTime?: number; method?: string } = {}): Promise<string> {
  return mintSession(
    { uid: UID, login: 'op', avatarUrl: null, roles: ['user'], ...(opts.authTime !== undefined ? { auth_time: opts.authTime, auth_method: opts.method ?? 'github' } : {}) },
    env.SESSION_SIGNING_KEY,
  );
}

/** A request as the host mediates it: session + asserted app + hostname. */
function call(path: string, token: string, body: unknown = {}, host: string | null = RP) {
  return SELF.fetch(`${BASE}/v1/auth/passkey/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-PAS-App': 'demo', ...(host ? { 'X-PAS-Host': host } : {}) },
    body: JSON.stringify(body),
  });
}

class Authenticator {
  counter = 0;
  readonly credId = crypto.getRandomValues(new Uint8Array(16));
  private constructor(readonly keys: CryptoKeyPair) {}
  static async create() {
    return new Authenticator((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair);
  }
  async authData(flags: number, withCredential: boolean) {
    const head = concat(await sha256(enc.encode(RP)), new Uint8Array([flags]), u32(this.counter));
    if (!withCredential) return head;
    return concat(head, new Uint8Array(16), new Uint8Array([0, this.credId.length]), this.credId);
  }
  async attest(challenge: string, o: { origin?: string } = {}) {
    const clientData = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? ORIGIN }));
    return {
      id: b64url(this.credId),
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(await this.authData(0x45, true)),
      publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('spki', this.keys.publicKey) as ArrayBuffer)),
      publicKeyAlgorithm: -7,
    };
  }
  async assert(challenge: string, o: { flags?: number; signer?: CryptoKey; bumpCounter?: boolean } = {}) {
    if (o.bumpCounter !== false) this.counter++;
    const clientData = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }));
    const authData = await this.authData(o.flags ?? 0x05, false);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.signer ?? this.keys.privateKey, concat(authData, await sha256(clientData))));
    return { id: b64url(this.credId), clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(rawToDer(raw)) };
  }
}

async function challengeFor(path: 'register/options' | 'step-up/options', token: string): Promise<string> {
  const res = await call(path, token);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

async function registered(): Promise<{ auth: Authenticator; token: string }> {
  const token = await signIn({ authTime: now() });
  const auth = await Authenticator.create();
  const res = await call('register', token, await auth.attest(await challengeFor('register/options', token)));
  expect(res.status, await res.clone().text()).toBe(200);
  return { auth, token };
}

beforeEach(async () => {
  for (const t of ['passkey_credentials', 'passkey_challenges']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('passkey registration (#230)', () => {
  it('registers a passkey from a fresh sign-in, bound to the app hostname', async () => {
    await registered();
    const row = await env.DB.prepare('SELECT user_id, rp_id, alg, sign_count FROM passkey_credentials').first();
    expect(row).toEqual({ user_id: UID, rp_id: RP, alg: -7, sign_count: 0 });
  });

  it('refuses a stale sign-in, and a pre-#230 session with no auth_time', async () => {
    for (const token of [await signIn({ authTime: now() - 3600 }), await signIn()]) {
      const res = await call('register/options', token);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'reauth_required' });
    }
  });

  it('once a passkey exists, adding another needs a passkey step-up, not just a fresh sign-in', async () => {
    const { auth } = await registered();
    const freshPassword = await signIn({ authTime: now(), method: 'password' });
    expect((await call('register/options', freshPassword)).status).toBe(403);

    const up = await call('step-up', freshPassword, await auth.assert(await challengeFor('step-up/options', freshPassword)));
    const { token: stepped } = (await up.json()) as { token: string };
    expect((await call('register/options', stepped)).status).toBe(200);
  });

  it('refuses a ceremony from another origin, and a request the host did not mediate', async () => {
    const token = await signIn({ authTime: now() });
    const auth = await Authenticator.create();
    const wrongOrigin = await call('register', token, await auth.attest(await challengeFor('register/options', token), { origin: 'https://evil.example' }));
    expect(wrongOrigin.status).toBe(400);
    expect((await call('register/options', token, {}, null)).status).toBe(400);
  });
});

describe('passkey step-up (#230)', () => {
  it('re-authenticates and issues a short-lived session with a fresh auth_time and method passkey', async () => {
    const { auth } = await registered();
    const oldTime = now() - 3000;
    const old = await signIn({ authTime: oldTime, method: 'github' });

    const res = await call('step-up', old, await auth.assert(await challengeFor('step-up/options', old)));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { token: string; auth_time: number; expires_at: number };
    const claims = (await verifySession(body.token, env.SESSION_SIGNING_KEY))!;
    expect(claims.uid).toBe(UID);
    expect(claims.auth_method).toBe('passkey');
    expect(claims.auth_time).toBeGreaterThan(oldTime);
    expect(claims.auth_time).toBe(body.auth_time);
    expect(claims.exp - claims.iat).toBe(3600);
    expect(body.expires_at).toBe(claims.exp);
    const row = await env.DB.prepare('SELECT sign_count, last_used_at FROM passkey_credentials').first<{ sign_count: number; last_used_at: number }>();
    expect(row!.sign_count).toBe(1);
    expect(row!.last_used_at).toBeGreaterThan(0);
  });

  it('a challenge is single-use: replaying a valid assertion is refused', async () => {
    const { auth, token } = await registered();
    const assertion = await auth.assert(await challengeFor('step-up/options', token));
    expect((await call('step-up', token, assertion)).status).toBe(200);
    expect((await call('step-up', token, assertion)).status).toBe(400);
  });

  it('refuses a signature from another key, a missing user verification, and a counter that does not advance', async () => {
    const { auth, token } = await registered();
    const other = await Authenticator.create();
    const forged = await call('step-up', token, await auth.assert(await challengeFor('step-up/options', token), { signer: other.keys.privateKey }));
    expect(forged.status).toBe(403);

    const noUv = await call('step-up', token, await auth.assert(await challengeFor('step-up/options', token), { flags: 0x01 }));
    expect(noUv.status).toBe(400);

    expect((await call('step-up', token, await auth.assert(await challengeFor('step-up/options', token)))).status).toBe(200);
    const cloned = await call('step-up', token, await auth.assert(await challengeFor('step-up/options', token), { bumpCounter: false }));
    expect(cloned.status).toBe(403);
  });

  it("refuses another user's challenge and a user with no passkey", async () => {
    const { auth, token } = await registered();
    const challenge = await challengeFor('step-up/options', token);
    const stranger = await mintSession({ uid: 'gh:8', login: 'x', avatarUrl: null, roles: ['user'] }, env.SESSION_SIGNING_KEY);
    expect((await call('step-up/options', stranger)).status).toBe(404);
    expect((await call('step-up', stranger, await auth.assert(challenge))).status).toBe(400);
  });
});
