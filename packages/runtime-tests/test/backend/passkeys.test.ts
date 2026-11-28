import { SELF, env } from 'cloudflare:test';
import { credentialContext, mintSession, verifySession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, viaHostApi } from './helpers';
import { Authenticator } from './webauthn';

// #230 (part of #228): passkey registration and step-up on real D1 and real
// WebCrypto. The "authenticator" (./webauthn) is a P-256 key producing the exact
// bytes a browser would: clientDataJSON, authenticatorData, a DER signature.

// #699: every surface on the platform zone shares one credential RP id; each
// app's step-up audience and ceremony origin stay its own hostname.
const RP = 'proappstore.online';
const HOST = 'demo.proappstore.online';
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
function call(path: string, token: string, body: unknown = {}, host: string | null = HOST, app = 'demo') {
  return viaHostApi(`${BASE}/v1/auth/passkey/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-PAS-App': app, ...(host ? { 'X-PAS-Host': host } : {}) },
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
  const auth = await Authenticator.create(RP, `https://${HOST}`);
  const res = await call('register', token, await auth.attest(await challengeFor('register/options', token)));
  expect(res.status, await res.clone().text()).toBe(200);
  return { auth, token };
}

beforeEach(async () => {
  for (const t of ['passkey_credentials', 'passkey_challenges']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('passkey registration (#230)', () => {
  it('registers a passkey from a fresh sign-in, under the shared platform RP id (#699)', async () => {
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
    const auth = await Authenticator.create(RP, `https://${HOST}`);
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
    expect(claims.step_up_rp_id).toBe(HOST);
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
    const other = await Authenticator.create(RP, `https://${HOST}`);
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
    // A key for an app hostname (the pre-#699 app RP id): wrong rpIdHash.
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

    // Registered on the console, a Console ceremony still refuses an assertion from an app origin.
    expect((await direct('register', token, await auth.attest((await challenge('register/options', token)).challenge, { origin: CONSOLE }))).status).toBe(200);
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

// #699: one passkey for the whole platform. A credential enrolled on any
// surface of the platform zone steps up on every other, but each step-up is
// bound to the surface that ran it: its challenge, its origin and the audience
// it mints.
describe('one passkey for the platform (#699)', () => {
  const CONSOLE = 'https://console.proappstore.online';
  const direct = (path: string, token: string, body: unknown = {}, origin = CONSOLE) =>
    SELF.fetch(`${BASE}/v1/auth/passkey/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
  const ok = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<{ challenge: string; token: string; rpId?: string; rp?: { id: string; name: string } }>;
  };
  const audienceOf = async (res: Response) => (await verifySession((await ok(res)).token, env.SESSION_SIGNING_KEY))!.step_up_rp_id;

  it('a passkey enrolled on the Console steps up in an app, minting that app\'s audience', async () => {
    const token = await signIn({ authTime: now() });
    const auth = await Authenticator.create(RP, CONSOLE);
    const reg = await ok(await direct('register/options', token));
    expect(reg.rp).toEqual({ id: RP, name: 'ProAppStore' });
    await ok(await direct('register', token, await auth.attest(reg.challenge)));

    const stale = await signIn({ authTime: now() - 7200 });
    const opts = await ok(await call('step-up/options', stale));
    expect(opts.rpId).toBe(RP);
    expect(await audienceOf(await call('step-up', stale, await auth.assert(opts.challenge, { origin: `https://${HOST}` })))).toBe(HOST);
    // ...and still on the Console, with the Console's audience.
    expect(await audienceOf(await direct('step-up', stale, await auth.assert((await ok(await direct('step-up/options', stale))).challenge)))).toBe(RP);
  });

  it('a passkey enrolled in an app steps up on the Console and in another app', async () => {
    const { auth } = await registered();
    const stale = await signIn({ authTime: now() - 7200 });
    expect(await audienceOf(await direct('step-up', stale, await auth.assert((await ok(await direct('step-up/options', stale))).challenge, { origin: CONSOLE })))).toBe(RP);
    const other = 'stash.proappstore.online';
    const opts = await ok(await call('step-up/options', stale, {}, other, 'stash'));
    expect(await audienceOf(await call('step-up', stale, await auth.assert(opts.challenge, { origin: `https://${other}` }), other, 'stash'))).toBe(other);
  });

  it('refuses a cross-surface replay: a challenge or assertion from one surface never completes on another', async () => {
    const { auth } = await registered();
    const token = await signIn({ authTime: now() - 7200 });
    // An app's challenge, signed from the app, submitted on the Console.
    const appChallenge = (await ok(await call('step-up/options', token))).challenge;
    expect((await direct('step-up', token, await auth.assert(appChallenge, { origin: `https://${HOST}` }))).status).toBe(400);
    // A Console challenge, signed from an app origin, submitted on the Console.
    const consoleChallenge = (await ok(await direct('step-up/options', token))).challenge;
    expect((await direct('step-up', token, await auth.assert(consoleChallenge, { origin: `https://${HOST}` }))).status).toBe(400);
    // A Console challenge, signed from the Console, submitted through an app.
    const consoleChallenge2 = (await ok(await direct('step-up/options', token))).challenge;
    expect((await call('step-up', token, await auth.assert(consoleChallenge2, { origin: CONSOLE }))).status).toBe(400);
    // One app's challenge and origin, submitted through another app.
    const demo = (await ok(await call('step-up/options', token))).challenge;
    expect((await call('step-up', token, await auth.assert(demo), 'stash.proappstore.online', 'stash')).status).toBe(400);
  });

  it('adding a second passkey needs a passkey step-up on the same surface, not another one', async () => {
    const { auth } = await registered();
    const token = await signIn({ authTime: now(), method: 'password' });
    const consoleStepUp = (await ok(await direct('step-up', token, await auth.assert((await ok(await direct('step-up/options', token))).challenge, { origin: CONSOLE })))).token;
    expect((await call('register/options', consoleStepUp)).status).toBe(403);
    expect((await direct('register/options', consoleStepUp)).status).toBe(200);
  });

  it('an app on a custom domain keeps its own hostname as relying party: a platform passkey does not apply there', async () => {
    const SHOP = 'shop.example.com';
    await registered();
    const token = await signIn({ authTime: now() });
    const none = await call('step-up/options', token, {}, SHOP, 'shop');
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ code: 'no_passkey' });

    const reg = await ok(await call('register/options', token, {}, SHOP, 'shop'));
    expect(reg.rp).toEqual({ id: SHOP, name: 'shop' });
    const local = await Authenticator.create(SHOP);
    await ok(await call('register', token, await local.attest(reg.challenge), SHOP, 'shop'));
    const stale = await signIn({ authTime: now() - 7200 });
    const opts = await ok(await call('step-up/options', stale, {}, SHOP, 'shop'));
    expect(opts.rpId).toBe(SHOP);
    expect(await audienceOf(await call('step-up', stale, await local.assert(opts.challenge), SHOP, 'shop'))).toBe(SHOP);
  });
});

// #700: a person lists, names and removes their own passkeys from the Console.
// Never a public key or counter, never through an app, never someone else's;
// removing needs a fresh sign-in or step-up; every change is audited.
describe('passkey management (#700)', () => {
  const CONSOLE = 'https://console.proappstore.online';
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const manage = (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = { Origin: CONSOLE }) =>
    SELF.fetch(`${BASE}/v1/auth/passkey/credentials${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async (token: string) => ((await (await manage('GET', '', token)).json()) as { credentials: Record<string, unknown>[] }).credentials;
  const audits = (id: string) => env.DB.prepare("SELECT action, actor_id, target_type, app_id FROM account_audit_events WHERE target_id = ?1 ORDER BY created_at, action").bind(id).all().then((r) => r.results);
  /** Register on the Console with `extra` body fields. */
  const enrollOnConsole = async (token: string, extra: Record<string, unknown> = {}) => {
    const auth = await Authenticator.create(RP, CONSOLE);
    const opts = (await (await SELF.fetch(`${BASE}/v1/auth/passkey/register/options`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: CONSOLE }, body: '{}' })).json()) as { challenge: string };
    return { auth, res: await SELF.fetch(`${BASE}/v1/auth/passkey/register`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: CONSOLE }, body: JSON.stringify({ ...(await auth.attest(opts.challenge)), ...extra }) }) };
  };

  it('registration takes a name and transports, or names the passkey from the user agent; the list shows only safe fields', async () => {
    const token = await signIn({ authTime: now() });
    const { auth: named, res } = await enrollOnConsole(token, { name: '  Work laptop  ', transports: ['internal', 'hybrid', 'bogus'] });
    expect(await res.json()).toMatchObject({ ok: true, name: 'Work laptop' });

    // Through an app, with no name: the host forwards the browser's user agent.
    const app = await Authenticator.create(RP, `https://${HOST}`);
    const viaApp = (path: string, body: unknown = {}) => viaHostApi(`${BASE}/v1/auth/passkey/${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-PAS-App': 'demo', 'X-PAS-Host': HOST, 'User-Agent': MAC_CHROME },
    });
    // A second passkey needs a step-up on this surface first.
    const up = await viaApp('step-up', await named.assert(((await (await viaApp('step-up/options')).json()) as { challenge: string }).challenge, { origin: `https://${HOST}` }));
    const stepped = ((await up.json()) as { token: string }).token;
    const reg = await viaHostApi(`${BASE}/v1/auth/passkey/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stepped}`, 'Content-Type': 'application/json', 'X-PAS-App': 'demo', 'X-PAS-Host': HOST, 'User-Agent': MAC_CHROME },
      body: JSON.stringify(await app.attest(((await (await viaHostApi(`${BASE}/v1/auth/passkey/register/options`, { method: 'POST', headers: { Authorization: `Bearer ${stepped}`, 'Content-Type': 'application/json', 'X-PAS-App': 'demo', 'X-PAS-Host': HOST }, body: '{}' })).json()) as { challenge: string }).challenge)),
    });
    expect(await reg.json()).toMatchObject({ ok: true, name: 'Mac · Chrome' });

    const creds = await list(token);
    expect(creds).toHaveLength(2);
    for (const c of creds) expect(Object.keys(c).sort()).toEqual(['created_at', 'id', 'last_used_at', 'name', 'rp_id', 'transports']);
    const byName = Object.fromEntries(creds.map((c) => [c.name, c]));
    expect(byName['Work laptop']).toMatchObject({ rp_id: RP, transports: ['internal', 'hybrid'] });
    expect(byName['Work laptop']!.last_used_at).toBeGreaterThan(0); // the step-up above used it
    expect(byName['Mac · Chrome']).toMatchObject({ rp_id: RP, transports: [], last_used_at: null });
    expect(await audits(byName['Mac · Chrome']!.id as string)).toEqual([{ action: 'passkey.add', actor_id: UID, target_type: 'passkey', app_id: 'demo' }]);
    expect(await audits(byName['Work laptop']!.id as string)).toEqual([{ action: 'passkey.add', actor_id: UID, target_type: 'passkey', app_id: null }]);
  });

  it('refuses a bad name at registration and on rename', async () => {
    const token = await signIn({ authTime: now() });
    expect((await enrollOnConsole(token, { name: 'x'.repeat(61) })).res.status).toBe(400);
    const { res } = await enrollOnConsole(token);
    const { id } = (await res.json()) as { id: string };
    for (const name of ['   ', 'x'.repeat(61), 42]) expect((await manage('PATCH', `/${id}`, token, { name })).status, String(name)).toBe(400);
    expect((await list(token))[0]!.name).toBe('Passkey'); // no user agent sent
  });

  it('renames only your own passkey, and audits it', async () => {
    const token = await signIn({ authTime: now() });
    const { id } = (await (await enrollOnConsole(token)).res.json()) as { id: string };
    const res = await manage('PATCH', `/${id}`, token, { name: ' Phone ' });
    expect(await res.json()).toEqual({ ok: true, id, name: 'Phone' });
    expect((await list(token))[0]!.name).toBe('Phone');

    const stranger = await mintSession({ uid: 'gh:8', login: 'x', avatarUrl: null, roles: ['user'], auth_time: now(), auth_method: 'github' }, env.SESSION_SIGNING_KEY);
    expect((await manage('PATCH', `/${id}`, stranger, { name: 'mine' })).status).toBe(404);
    expect(await list(stranger)).toEqual([]);
    expect((await audits(id)).map((a) => a.action)).toEqual(['passkey.add', 'passkey.rename']);
  });

  it('removing needs a fresh sign-in or passkey step-up, and only removes your own', async () => {
    const fresh = await signIn({ authTime: now() });
    const { auth, res } = await enrollOnConsole(fresh);
    const { id } = (await res.json()) as { id: string };

    const stale = await signIn({ authTime: now() - 3600 });
    const refused = await manage('DELETE', `/${id}`, stale);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'reauth_required' });
    const stranger = await mintSession({ uid: 'gh:8', login: 'x', avatarUrl: null, roles: ['user'], auth_time: now(), auth_method: 'github' }, env.SESSION_SIGNING_KEY);
    expect((await manage('DELETE', `/${id}`, stranger)).status).toBe(404);

    // A Console passkey step-up from the stale session is fresh enough.
    const opts = (await (await SELF.fetch(`${BASE}/v1/auth/passkey/step-up/options`, { method: 'POST', headers: { Authorization: `Bearer ${stale}`, 'Content-Type': 'application/json', Origin: CONSOLE }, body: '{}' })).json()) as { challenge: string };
    const up = await SELF.fetch(`${BASE}/v1/auth/passkey/step-up`, { method: 'POST', headers: { Authorization: `Bearer ${stale}`, 'Content-Type': 'application/json', Origin: CONSOLE }, body: JSON.stringify(await auth.assert(opts.challenge)) });
    const stepped = ((await up.json()) as { token: string }).token;
    expect(await (await manage('DELETE', `/${id}`, stepped)).json()).toEqual({ ok: true, id });
    expect(await list(fresh)).toEqual([]);
    expect((await manage('DELETE', `/${id}`, fresh)).status).toBe(404);
    expect((await audits(id)).map((a) => a.action)).toEqual(['passkey.add', 'passkey.remove']);
  });

  it('is only reachable from the Console: never through an app, another origin or an app-bound session', async () => {
    const token = await signIn({ authTime: now() });
    const { id } = (await (await enrollOnConsole(token)).res.json()) as { id: string };
    // The cookie data plane: X-PAS-App, no X-PAS-Host; and a full app mediation.
    for (const headers of [{ 'X-PAS-App': 'demo' }, { 'X-PAS-App': 'demo', 'X-PAS-Host': HOST }] as Record<string, string>[]) {
      const res = await viaHostApi(`${BASE}/v1/auth/passkey/credentials/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Origin: CONSOLE, ...headers } });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    for (const headers of [{}, { Origin: `https://${HOST}` }, { Origin: 'https://evil.example' }] as Record<string, string>[]) {
      expect((await manage('GET', '', token, undefined, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    const appBound = await mintSession({ uid: UID, login: 'op', avatarUrl: null, roles: ['user'], auth_time: now(), auth_method: 'github', cred: credentialContext('app_bound', 'demo') } as never, env.SESSION_SIGNING_KEY);
    expect((await manage('DELETE', `/${id}`, appBound)).status).toBe(403);
    expect(await list(token)).toHaveLength(1);
  });
});
