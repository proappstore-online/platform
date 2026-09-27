import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAccessJwksCache, AccessKeysUnavailable, verifyAccessJwt } from "./access-jwt.js";
import worker from "./index.js";
import type { Env } from "./env.js";

/**
 * #233 (part of #228): Cloudflare Access JWTs are verified — signature against
 * the team JWKS, issuer, audience, expiry — not merely checked for presence.
 * A real RSA key signs the tokens; the JWKS endpoint is a stubbed fetch.
 */

const TEAM = "proappstore.cloudflareaccess.com";
const AUD = "aud-tag-1234";
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;
const NOW_S = Math.floor(Date.now() / 1000);

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64json = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

async function rsaKey(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  return { pair, jwk, kid };
}

type Key = Awaited<ReturnType<typeof rsaKey>>;
let signing: Key;
let stranger: Key;

async function sign(claims: Record<string, unknown>, key: Key = signing, header: Record<string, unknown> = {}): Promise<string> {
  const h = b64json({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = b64json(claims);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.pair.privateKey, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`, aud: [AUD], sub: "user-1", email: "ops@example.com", iat: NOW_S, nbf: NOW_S, exp: NOW_S + 3600, ...over,
});

function jwksFetch(keys = [signing.jwk]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(CERTS);
    return Response.json({ keys });
  });
}

beforeEach(async () => {
  _resetAccessJwksCache();
  signing ??= await rsaKey("k1");
  stranger ??= await rsaKey("k1"); // same kid, different key: a forged token
});
afterEach(() => vi.unstubAllGlobals());

describe("verifyAccessJwt (#233)", () => {
  const verify = (token: string, fetchImpl = jwksFetch()) => verifyAccessJwt(token, { teamDomain: TEAM, audience: AUD, fetchImpl });

  it("accepts a valid token and returns its claims", async () => {
    const claims = await verify(await sign(goodClaims()));
    expect(claims.email).toBe("ops@example.com");
  });

  it("accepts a string aud as well as an array", async () => {
    await expect(verify(await sign(goodClaims({ aud: AUD })))).resolves.toBeTruthy();
  });

  it("refuses a token signed by another key", async () => {
    await expect(verify(await sign(goodClaims(), stranger))).rejects.toThrow("signature verification failed");
  });

  it("refuses a tampered payload", async () => {
    const [h, , s] = (await sign(goodClaims())).split(".");
    await expect(verify(`${h}.${b64json(goodClaims({ email: "admin@evil.example" }))}.${s}`)).rejects.toThrow("signature verification failed");
  });

  it("refuses an expired token (beyond the 60 s skew) and a not-yet-valid one", async () => {
    await expect(verify(await sign(goodClaims({ exp: NOW_S - 61 })))).rejects.toThrow("token expired");
    await expect(verify(await sign(goodClaims({ exp: undefined })))).rejects.toThrow("token expired");
    await expect(verify(await sign(goodClaims({ nbf: NOW_S + 3600 })))).rejects.toThrow("not yet valid");
  });

  it("refuses the wrong audience and the wrong issuer", async () => {
    await expect(verify(await sign(goodClaims({ aud: ["another-app"] })))).rejects.toThrow("audience mismatch");
    await expect(verify(await sign(goodClaims({ iss: "https://evil.cloudflareaccess.com" })))).rejects.toThrow("unexpected issuer");
  });

  it("refuses alg other than RS256, a missing kid, an unknown kid, and malformed tokens", async () => {
    await expect(verify(await sign(goodClaims(), signing, { alg: "HS256" }))).rejects.toThrow("unexpected alg");
    await expect(verify(await sign(goodClaims(), signing, { kid: undefined }))).rejects.toThrow("missing kid");
    await expect(verify(await sign(goodClaims(), signing, { kid: "nope" }))).rejects.toThrow("signing key not found");
    await expect(verify("not.a.jwt")).rejects.toThrow("malformed JWT");
    await expect(verify("abc")).rejects.toThrow("malformed JWT");
  });

  it("refetches the JWKS once on an unknown kid (key rotation) and caches otherwise", async () => {
    const rotated = await rsaKey("k2");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ keys: [signing.jwk] }))
      .mockResolvedValueOnce(Response.json({ keys: [signing.jwk, rotated.jwk] }));
    await verifyAccessJwt(await sign(goodClaims()), { teamDomain: TEAM, audience: AUD, fetchImpl });
    await verifyAccessJwt(await sign(goodClaims(), rotated), { teamDomain: TEAM, audience: AUD, fetchImpl });
    await verifyAccessJwt(await sign(goodClaims()), { teamDomain: TEAM, audience: AUD, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports an unreachable JWKS as AccessKeysUnavailable", async () => {
    const down = vi.fn(async () => new Response("no", { status: 502 }));
    await expect(verify(await sign(goodClaims()), down)).rejects.toBeInstanceOf(AccessKeysUnavailable);
  });

  it("refuses a team domain that is not <team>.cloudflareaccess.com", async () => {
    const fetchImpl = jwksFetch();
    await expect(verifyAccessJwt(await sign(goodClaims()), { teamDomain: "evil.example", audience: AUD, fetchImpl })).rejects.toThrow("invalid Access team domain");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("admin worker: Access edge enforcement (#233)", () => {
  const ctx = {} as ExecutionContext;
  const enforcing = (over: Partial<Env> = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, INTERNAL_TOKEN: "internal-secret", ...over }) as unknown as Env;
  // /api/turnstile needs no other binding, so reaching it (200) means the edge check passed.
  const turnstile = (headers: Record<string, string> = {}) => new Request("https://admin.proappstore.online/api/turnstile", { headers });

  it("a valid Access token passes", async () => {
    vi.stubGlobal("fetch", jwksFetch());
    const res = await worker.fetch(turnstile({ "Cf-Access-Jwt-Assertion": await sign(goodClaims()) }), enforcing(), ctx);
    expect(res.status).toBe(200);
  });

  it("a missing token is refused with 401, on reads and writes alike", async () => {
    vi.stubGlobal("fetch", jwksFetch());
    const read = await worker.fetch(turnstile(), enforcing(), ctx);
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: "Cloudflare Access authentication required" });
    const write = await worker.fetch(new Request("https://admin.proappstore.online/api/publish-app", { method: "POST", body: "{}" }), enforcing(), ctx);
    expect(write.status).toBe(401);
  });

  it("an invalid (forged) token is refused with 401", async () => {
    vi.stubGlobal("fetch", jwksFetch());
    const res = await worker.fetch(turnstile({ "Cf-Access-Jwt-Assertion": await sign(goodClaims(), stranger) }), enforcing(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid Cloudflare Access token" });
  });

  it("an expired token is refused with 401", async () => {
    vi.stubGlobal("fetch", jwksFetch());
    const res = await worker.fetch(turnstile({ "Cf-Access-Jwt-Assertion": await sign(goodClaims({ exp: NOW_S - 3600 })) }), enforcing(), ctx);
    expect(res.status).toBe(401);
  });

  it("fails closed with 503 when the Access keys cannot be fetched or the team domain is misconfigured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const token = await sign(goodClaims());
    expect((await worker.fetch(turnstile({ "Cf-Access-Jwt-Assertion": token }), enforcing(), ctx)).status).toBe(503);
    expect((await worker.fetch(turnstile({ "Cf-Access-Jwt-Assertion": token }), enforcing({ ACCESS_TEAM_DOMAIN: "evil.example" }), ctx)).status).toBe(503);
  });

  it("sibling Workers on INTERNAL_TOKEN and /health are exempt; a wrong internal token is not", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await worker.fetch(turnstile({ "X-Internal-Token": "internal-secret" }), enforcing(), ctx)).status).toBe(200);
    expect((await worker.fetch(new Request("https://admin.proappstore.online/health"), enforcing(), ctx)).status).toBe(200);
    expect((await worker.fetch(turnstile({ "X-Internal-Token": "guess" }), enforcing(), ctx)).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("unconfigured (either var unset), nothing changes: no token needed, a mutating request only warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const env of [{} as Env, { ACCESS_AUD: AUD } as unknown as Env, { ACCESS_TEAM_DOMAIN: TEAM } as unknown as Env]) {
      expect((await worker.fetch(turnstile(), env, ctx)).status).toBe(200);
    }
    const res = await worker.fetch(new Request("https://admin.proappstore.online/api/publish-app", { method: "POST", body: "{}" }), {} as Env, ctx);
    expect(res.status).toBe(401); // the route's own session check, as before
    expect(await res.json()).toEqual({ error: "invalid or expired session" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reached without Cf-Access-Jwt-Assertion"));
    warn.mockRestore();
  });
});
