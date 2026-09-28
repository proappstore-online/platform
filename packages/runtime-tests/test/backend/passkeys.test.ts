import { SELF, env } from 'cloudflare:test';
import { mintSession, verifySession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE } from './helpers';
import { Authenticator } from './webauthn';

// #230 (part of #228): passkey registration and step-up on real D1 and real
// WebCrypto. The "authenticator" (./webauthn) is a P-256 key producing the exact
// bytes a browser would: clientDataJSON, authenticatorData, a DER signature.

const RP = 'demo.proappstore.online';
const UID = 'gh:7';
const now = () => Math.floor(Date.now() / 1000);

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

async function challengeFor(path: 'register/options' | 'step-up/options', token: string): Promise<string> {
  const res = await call(path, token);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

async function registered(): Promise<{ auth: Authenticator; token: string }> {
  const token = await signIn({ authTime: now() });
  const auth = await Authenticator.create(RP);
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
    const auth = await Authenticator.create(RP);
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
    const other = await Authenticator.create(RP);
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

// #244: the Creator Console is a legacy-bearer page on its own origin that calls
// the API directly — no host mediation — so its passkeys are bound to its own
// hostname, and only a ceremony from that origin can complete.
describe('console relying party (#244)', () => {
  const CONSOLE = 'console.proappstore.online';
  const direct = (path: string, token: string, body: unknown = {}, headers: Record<string, string> = { Origin: `https://${CONSOLE}` }) =>
    SELF.fetch(`${BASE}/v1/auth/passkey/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const challenge = async (path: string, token: string) => {
    const res = await direct(path, token);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { challenge: string; rp?: { id: string }; rpId?: string };
  };

  it('registers and steps up from the console origin, bound to the console hostname', async () => {
    const token = await signIn({ authTime: now() });
    const auth = await Authenticator.create(CONSOLE);
    const reg = await challenge('register/options', token);
    expect(reg.rp?.id).toBe(CONSOLE);
    expect((await direct('register', token, await auth.attest(reg.challenge))).status).toBe(200);
    expect(await env.DB.prepare('SELECT rp_id FROM passkey_credentials WHERE user_id = ?').bind(UID).first()).toEqual({ rp_id: CONSOLE });

    const stale = await signIn({ authTime: now() - 7200 });
    const opts = await challenge('step-up/options', stale);
    expect(opts.rpId).toBe(CONSOLE);
    const res = await direct('step-up', stale, await auth.assert(opts.challenge));
    expect(res.status, await res.clone().text()).toBe(200);
    const claims = await verifySession(((await res.json()) as { token: string }).token, env.SESSION_SIGNING_KEY);
    expect(claims).toMatchObject({ uid: UID, auth_method: 'passkey' });
    expect(now() - claims!.auth_time!).toBeLessThanOrEqual(2);
  });

  it('refuses a direct call without the console Origin, from an app page, or through host mediation', async () => {
    const token = await signIn({ authTime: now() });
    expect((await direct('register/options', token, {}, {})).status).toBe(400);
    expect((await direct('register/options', token, {}, { Origin: 'https://stash.proappstore.online' })).status).toBe(400);
    expect((await direct('register/options', token, {}, { Origin: 'https://proappstore.online' })).status).toBe(400);
    // The cookie data plane sets X-PAS-App and strips X-PAS-Host: still no relying party, so page JS never gets a token.
    expect((await direct('register/options', token, {}, { Origin: `https://${CONSOLE}`, 'X-PAS-App': 'stash' })).status).toBe(400);
  });

  it("an app page's key or ceremony cannot enroll or step up on the console", async () => {
    const token = await signIn({ authTime: now() });
    // A key for an app hostname: wrong rpIdHash.
    const appKey = await Authenticator.create('stash.proappstore.online');
    expect((await direct('register', token, await appKey.attest((await challenge('register/options', token)).challenge))).status).toBe(400);
    // The console's rpId but an app origin in clientDataJSON.
    const auth = await Authenticator.create(CONSOLE);
    const wrongOrigin = await direct('register', token, await auth.attest((await challenge('register/options', token)).challenge, { origin: 'https://stash.proappstore.online' }));
    expect(wrongOrigin.status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM passkey_credentials').first()).toEqual({ n: 0 });

    // Registered on the console, a passkey is not accepted for an app's step-up, nor the reverse.
    expect((await direct('register', token, await auth.attest((await challenge('register/options', token)).challenge))).status).toBe(200);
    expect((await call('step-up/options', token)).status).toBe(404); // demo app: no passkey there
    const opts = await challenge('step-up/options', token);
    expect((await direct('step-up', token, await auth.assert(opts.challenge, { origin: 'https://stash.proappstore.online' }))).status).toBe(400);
  });
});
