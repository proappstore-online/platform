// Self-contained HS256 session auth for proappstore-admin.
// Pattern vendored from pgs/admin (2026-05-28): the admin Worker verifies
// sessions with its OWN SESSION_SIGNING_KEY — no dependency on FAS's signing
// key (per the admin-worker-per-store principle).
//
// This Worker no longer MINTS sessions (#142). It used to expose
// POST /v1/auth/exchange, which turned any valid GitHub token — issued to any
// OAuth app, or a leaked PAT — into a 30-day session for that login, because
// GitHub's whoami endpoint answers "whose token" but never "issued to whom".
// The backend's /v1/auth/exchange is audience-checked (#84/#103) and
// verifySession below accepts the sessions it mints, so the copy here was
// redundant. `pas login` goes through the backend, not this Worker.
import { verifySession as verifyPasSession } from "@proappstore/build-core";

/** Accepts a backend-minted PAS session, or a legacy 3-part admin session
 *  minted before #142 removed the exchange (valid for up to 30 days after). */
export async function verifySession(token: string, signingKey: string): Promise<string | null> {
  const pasClaims = await verifyPasSession(token, signingKey);
  if (pasClaims) return pasClaims.login ?? pasClaims.uid;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const bodyPart = parts[1];
    const sigPart = parts[2];
    if (!bodyPart || !sigPart) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = Uint8Array.from(atob(sigPart), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(atob(bodyPart)) as { sub: string; exp: number };
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function handleAuthMe(
  request: Request,
  env: { SESSION_SIGNING_KEY: string },
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }
  const login = await verifySession(authHeader.slice(7), env.SESSION_SIGNING_KEY);
  if (!login) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }
  return new Response(JSON.stringify({ login }), { headers: JSON_HEADERS });
}
