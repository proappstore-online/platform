import { SELF, env } from 'cloudflare:test';
import { mintSession, verifySession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, viaHostApi } from './helpers';
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

/** A request as the host mediates it: session + asserted app + hostname, through its HostApi binding (#315). */
function call(path: string, token: string, body: unknown = {}, host: string | null = RP) {
  return viaHostApi(`${BASE}/v1/auth/passkey/${path}`, {
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
    expect(claims.step_up_rp_id).toBe(RP);
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

// #244, #698: the Creator Console is a legacy-bearer page that calls the API
// directly — no host mediation. It is served at console.proappstore.online and
// at the storefront's proappstore.online/app/ mirror, so its passkeys belong to
// the parent relying party proappstore.online, and only a ceremony from one of
// those two origins can complete.
describe('console relying party (#244, #698)', () => {
  const RP_ID = 'proappstore.online';
  const CONSOLE = 'https://console.proappstore.online';
  const MIRROR = 'https://proappstore.online';
  const direct = (path: string, token: string, body: unknown = {}, headers: Record<string, string> = { Origin: CONSOLE }) =>
    SELF.fetch(`${BASE}/v1/auth/passkey/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const challenge = async (path: string, token: string, origin = CONSOLE) => {
    const res = await direct(path, token, {}, { Origin: origin });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { challenge: string; rp?: { id: string }; rpId?: string };
  };
  /** Register a Console passkey from `origin`, the way a browser there would. */
  const enroll = async (origin: string) => {
    const token = await signIn({ authTime: now() });
    const auth = await Authenticator.create(RP_ID);
    const reg = await challenge('register/options', token, origin);
    expect(reg.rp?.id).toBe(RP_ID);
    const res = await direct('register', token, await auth.attest(reg.challenge, { origin }), { Origin: origin });
    expect(res.status, await res.clone().text()).toBe(200);
    return auth;
  };
  const stepUp = async (auth: Authenticator, origin: string) => {
    const stale = await signIn({ authTime: now() - 7200 });
    const opts = await challenge('step-up/options', stale, origin);
    expect(opts.rpId).toBe(RP_ID);
    return direct('step-up', stale, await auth.assert(opts.challenge, { origin }), { Origin: origin });
  };

  it('a passkey set up on either Console host steps up on both, minting the Console audience', async () => {
    for (const [registeredOn, usedOn] of [[CONSOLE, MIRROR], [MIRROR, CONSOLE]] as const) {
      await env.DB.prepare('DELETE FROM passkey_credentials').run();
      const auth = await enroll(registeredOn);
      expect(await env.DB.prepare('SELECT rp_id FROM passkey_credentials WHERE user_id = ?').bind(UID).first()).toEqual({ rp_id: RP_ID });
      for (const origin of [registeredOn, usedOn]) {
        const res = await stepUp(auth, origin);
        expect(res.status, `${registeredOn} → ${origin}: ${await res.clone().text()}`).toBe(200);
        const claims = await verifySession(((await res.json()) as { token: string }).token, env.SESSION_SIGNING_KEY);
        expect(claims).toMatchObject({ uid: UID, auth_method: 'passkey', step_up_rp_id: RP_ID });
        expect(now() - claims!.auth_time!).toBeLessThanOrEqual(2);
      }
    }
  });

  it('refuses a direct call from any other origin, and through host mediation', async () => {
    const token = await signIn({ authTime: now() });
    const others: Record<string, string>[] = [{}, { Origin: 'https://stash.proappstore.online' }, { Origin: 'https://proappstore-console.pages.dev' }, { Origin: 'http://proappstore.online' }];
    for (const headers of others) {
      expect((await direct('register/options', token, {}, headers)).status, JSON.stringify(headers)).toBe(400);
    }
    // The cookie data plane sets X-PAS-App and strips X-PAS-Host: still no relying party, so page JS never gets a token.
    const mediate = (host: Record<string, string>) => viaHostApi(`${BASE}/v1/auth/passkey/register/options`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: CONSOLE, 'X-PAS-App': 'stash', ...host },
      body: '{}',
    });
    expect((await mediate({})).status).toBe(400);
    // A host-asserted hostname the Console relying party covers is never an app's.
    expect((await mediate({ 'X-PAS-Host': RP_ID })).status).toBe(400);
    expect((await mediate({ 'X-PAS-Host': 'console.proappstore.online' })).status).toBe(400);
  });

  // #334: the Console calls api.proappstore.online straight from the browser. That
  // host is not behind Cloudflare Access and CORS allows only Authorization and
  // Content-Type, so a real ceremony carries exactly those headers and Origin.
  it('accepts the request a browser on either Console host actually sends (#334)', async () => {
    for (const origin of [CONSOLE, MIRROR]) {
      const preflight = await SELF.fetch(`${BASE}/v1/auth/passkey/register/options`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
      });
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).not.toContain('cf-access-jwt-assertion');

      const token = await signIn({ authTime: now() });
      const res = await SELF.fetch(`${BASE}/v1/auth/passkey/register/options`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: origin },
        body: '{}',
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { rp: { id: string } }).rp.id).toBe(RP_ID);
    }
  });

  it('an unverified Cf-Access-Jwt-Assertion selects nothing (#334)', async () => {
    const token = await signIn({ authTime: now() });
    expect((await direct('register/options', token, {}, { 'Cf-Access-Jwt-Assertion': 'forged' })).status).toBe(400);
    expect((await direct('register/options', token, {}, { Origin: 'https://stash.proappstore.online', 'Cf-Access-Jwt-Assertion': 'forged' })).status).toBe(400);
  });

  // An app page on <app>.proappstore.online may name the parent RP id too (#698);
  // its clientDataJSON then carries the app origin, which must never pass.
  it("an app page's key or ceremony cannot enroll or step up on the console", async () => {
    const token = await signIn({ authTime: now() });
    // A key for an app hostname: wrong rpIdHash.
    const appKey = await Authenticator.create('stash.proappstore.online');
    expect((await direct('register', token, await appKey.attest((await challenge('register/options', token)).challenge))).status).toBe(400);
    // The Console's RP id, from an app origin, another Console host than the request's, or the pre-#698 RP id.
    const auth = await Authenticator.create(RP_ID);
    for (const origin of ['https://stash.proappstore.online', MIRROR]) {
      const res = await direct('register', token, await auth.attest((await challenge('register/options', token)).challenge, { origin }));
      expect(res.status, origin).toBe(400);
    }
    const legacy = await Authenticator.create('console.proappstore.online');
    expect((await direct('register', token, await legacy.attest((await challenge('register/options', token)).challenge))).status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM passkey_credentials').first()).toEqual({ n: 0 });

    // Registered on the console, a passkey is not accepted for an app's step-up, nor from an app origin.
    expect((await direct('register', token, await auth.attest((await challenge('register/options', token)).challenge, { origin: CONSOLE }))).status).toBe(200);
    expect((await call('step-up/options', token)).status).toBe(404); // demo app: no passkey there
    const opts = await challenge('step-up/options', token);
    expect((await direct('step-up', token, await auth.assert(opts.challenge, { origin: 'https://stash.proappstore.online' }))).status).toBe(400);
  });

  it('a credential bound to the pre-#698 RP id is neither offered nor accepted: the owner sets up a new passkey', async () => {
    const legacy = await Authenticator.create('console.proappstore.online');
    const { id, publicKey } = await legacy.attest('unused');
    await env.DB.prepare('INSERT INTO passkey_credentials (id, user_id, rp_id, public_key, alg, sign_count, created_at) VALUES (?1, ?2, ?3, ?4, -7, 0, 0)')
      .bind(id, UID, 'console.proappstore.online', publicKey).run();
    const token = await signIn({ authTime: now() });
    const none = await direct('step-up/options', token);
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ code: 'no_passkey' });
    // Even with a live Console challenge, the old credential is unknown here.
    await env.DB.prepare('DELETE FROM passkey_credentials').run();
    const auth = await enroll(CONSOLE);
    const opts = await challenge('step-up/options', token);
    await env.DB.prepare('INSERT INTO passkey_credentials (id, user_id, rp_id, public_key, alg, sign_count, created_at) VALUES (?1, ?2, ?3, ?4, -7, 0, 0)')
      .bind(id, UID, 'console.proappstore.online', publicKey).run();
    const replay = await direct('step-up', token, await legacy.assert(opts.challenge, { origin: CONSOLE }));
    expect(replay.status).toBe(400);
    expect((await direct('step-up', token, await auth.assert(opts.challenge, { origin: CONSOLE }))).status).toBe(200);
  });
});
