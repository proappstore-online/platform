// Self-contained HS256 session auth for proappstore-admin.
// Pattern vendored from pgs/admin (2026-05-28): the admin Worker mints +
// verifies its OWN sessions with its OWN SESSION_SIGNING_KEY — no
// dependency on FAS's signing key (per the admin-worker-per-store
// principle). `pas login` exchanges a GitHub token for a session here.

interface GitHubUser {
  login: string;
  id: number;
}

async function verifyGithubToken(token: string): Promise<GitHubUser | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "proappstore-admin",
    },
  });
  if (!res.ok) return null;
  return (await res.json()) as GitHubUser;
}

async function mintSessionToken(login: string, signingKey: string): Promise<string> {
  const payload = {
    sub: login,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
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

export async function verifySession(token: string, signingKey: string): Promise<string | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = Uint8Array.from(atob(parts[2]!), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1]!)) as { sub: string; exp: number };
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function handleAuthExchange(
  request: Request,
  env: { SESSION_SIGNING_KEY: string },
): Promise<Response> {
  let body: { githubToken?: string };
  try {
    body = (await request.json()) as { githubToken?: string };
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: JSON_HEADERS });
  }
  if (!body.githubToken) {
    return new Response(JSON.stringify({ error: "missing githubToken" }), { status: 400, headers: JSON_HEADERS });
  }
  const user = await verifyGithubToken(body.githubToken);
  if (!user) {
    return new Response(JSON.stringify({ error: "invalid GitHub token" }), { status: 401, headers: JSON_HEADERS });
  }
  const sessionToken = await mintSessionToken(user.login, env.SESSION_SIGNING_KEY);
  return new Response(JSON.stringify({ sessionToken, login: user.login }), { headers: JSON_HEADERS });
}

export async function handleAuthMe(
  request: Request,
  env: { SESSION_SIGNING_KEY: string },
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }
  const login = await verifySession(authHeader.slice(7), env.SESSION_SIGNING_KEY);
  if (!login) {
    return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 401, headers: JSON_HEADERS });
  }
  return new Response(JSON.stringify({ login }), { headers: JSON_HEADERS });
}
