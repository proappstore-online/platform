import { mintSession } from "@proappstore/build-core";
import { describe, expect, it } from "vitest";
import { verifySession } from "./auth.js";

const KEY = "test-signing-key";

async function mintLegacySession(login: string, signingKey: string): Promise<string> {
  const payload = {
    sub: login,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    iss: "proappstore",
  };
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "");
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, "");
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "");
  return `${header}.${body}.${sigB64}`;
}

describe("verifySession", () => {
  it("accepts PAS sessions minted by build-core", async () => {
    const token = await mintSession(
      { uid: "gh:2824906", login: "serge-ivo", roles: ["user", "creator", "admin"] },
      KEY,
    );

    await expect(verifySession(token, KEY)).resolves.toBe("serge-ivo");
  });

  it("keeps accepting legacy admin sessions", async () => {
    const token = await mintLegacySession("serge-ivo", KEY);

    await expect(verifySession(token, KEY)).resolves.toBe("serge-ivo");
  });
});
