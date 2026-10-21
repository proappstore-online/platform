/**
 * OAuth 2.1 provider for MCP servers — vendorable, self-contained.
 * Vendor this + session.ts into each MCP worker.
 * State is supplied by the serialized SQLite OAuthState authority.
 */

import { mintSession, verifySession } from "./session.js";
import type { NewSession } from "./session.js";

const AUTH_NONCE_COOKIE = "pas_mcp_oauth_nonce";
const AUTH_PROVIDERS = ["github", "google"] as const;
const APP_ID_RE = /^[a-z][a-z0-9-]{0,57}$/;
/** Refresh-token lifetime default (#418): "sign-ins should last 90 days". */
const DEFAULT_REFRESH_TTL_SECONDS = 90 * 86_400;
/** Return the same rotation for a brief lost-response/concurrent-refresh retry.
 * A retry never creates a second successor. Reuse after this window revokes the family. */
export const REFRESH_RETRY_SECONDS = 30;
interface RotationResponse { access_token: string; token_type: string; expires_in: number; refresh_token: string }
type AuthProvider = typeof AUTH_PROVIDERS[number];

export interface OAuthTokenResolution {
  session: string;
  appId: string | null;
  bound: boolean;
  /** Present only for a credential issued to a remote-auth broker request. */
  brokerRequestId?: string;
  /** The grant (authorization family) this token descends from; absent on tokens issued before grants were indexed. */
  familyId?: string;
}

/**
 * Mint an opaque credential for the remote-auth broker.  This is intentionally
 * exported only for the MCP worker's authenticated service-binding endpoint:
 * callers receive an opaque value whose resource binding is enforced by
 * resolveOAuthToken/index.ts, never a PAS session JWT.
 */
export async function issueBrokerCredential(
  config: Pick<OAuthConfig, "issuer" | "kv" | "sessionSigningKey">,
  input: { session: string; ownerId: string; resource: string; requestId: string },
): Promise<string | null> {
  const target = resourceTarget(input.resource, config.issuer);
  if (!target.ok) return null;
  const claims = await verifySession(input.session, config.sessionSigningKey);
  if (!claims || claims.uid !== input.ownerId) return null;

  // The opaque value is deterministic for this one immutable request, but is
  // an HMAC of the request id, not the request id itself.  This deliberately
  // avoids KV's non-atomic get-then-put idempotency trap: concurrent recovery
  // calls can only write the same token mapping and can never create a second
  // usable credential.
  const token = await brokerToken(config.sessionSigningKey, input.requestId);
  const key = `broker-token:${input.requestId}`;
  const existing = await config.kv.get(key);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { token?: unknown; ownerId?: unknown; appId?: unknown };
      if (typeof parsed.token === "string" && parsed.ownerId === input.ownerId && parsed.appId === target.appId) return parsed.token;
    } catch { /* fail closed below */ }
    return null;
  }

  await config.kv.put(
    `token:${token}`,
    JSON.stringify({ session: input.session, appId: target.appId, brokerRequestId: input.requestId }),
    { expirationTtl: 86_400 },
  );
  await config.kv.put(
    key,
    JSON.stringify({ token, ownerId: input.ownerId, appId: target.appId }),
    { expirationTtl: 900 },
  );
  return token;
}

async function brokerToken(signingKey: string, requestId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`pas:mcp:broker:v2:${requestId}`)));
  return base64url(mac);
}

export interface OAuthConfig {
  /** Base URL of this MCP server (e.g. "https://mcp.proappstore.online") */
  issuer: string;
  /** Auth start URL (e.g. "https://api.proappstore.online/v1/auth/github/start") */
  authStart: string;
  /** Service binding for server-to-server API calls from this Worker. */
  api?: Fetcher;
  /** OAuth providers exposed by this MCP server. Defaults to GitHub + Google. */
  authProviders?: readonly AuthProvider[];
  /** Trusted CIMD hosts. Other clients can use dynamic registration. */
  clientMetadataHosts?: readonly string[];
  /** String/TTL store supplied by OAuthState (KV-compatible adapter). */
  kv: KVNamespace;
  /** HMAC signing key for session verification */
  sessionSigningKey: string;
  /**
   * Refresh-token lifetime in seconds (#418). Defaults to 90 days. Every
   * successful refresh rotates to a new token and resets this window, so a
   * client that keeps its access token renewed never has to send the user
   * back through the browser.
   */
  refreshTokenTtlSeconds?: number;
}

export function createAuthChallenge(
  config: Pick<OAuthConfig, "issuer"> & { appId?: string | null },
  error?: "invalid_token",
): Response {
  const metadataPath = config.appId
    ? `/.well-known/oauth-protected-resource/mcp/apps/${config.appId}`
    : "/.well-known/oauth-protected-resource/mcp";
  const metadata = new URL(metadataPath, config.issuer);
  const params = [`resource_metadata="${metadata.toString()}"`];
  if (error) params.push(`error="${error}"`);
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer ${params.join(", ")}`,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate",
      "Cache-Control": "no-store",
    },
  });
}

/** Try to handle an OAuth-related request. Returns null if not an OAuth path. */
export async function handleOAuthRoute(
  request: Request,
  config: OAuthConfig,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight for OAuth endpoints
  if (request.method === "OPTIONS") {
    if (
      path.startsWith("/.well-known/") ||
      path === "/register" ||
      path === "/authorize" ||
      path === "/authorize/continue" ||
      path === "/oauth/callback" ||
      path === "/token" ||
      path === "/revoke"
    ) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
  }

  const protectedResource = protectedResourceFromPath(path, config.issuer);
  if (protectedResource) {
    return json({
      resource: protectedResource,
      authorization_servers: [config.issuer],
    });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      revocation_endpoint: `${config.issuer}/revoke`,
      registration_endpoint: `${config.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
  }
  if (path === "/register" && request.method === "POST") {
    return register(request, config);
  }
  if (path === "/authorize" && request.method === "GET") {
    return authorize(request, config);
  }
  if (path === "/authorize/continue" && request.method === "GET") {
    return continueAuthorize(request, config);
  }
  if (path === "/oauth/callback" && request.method === "GET") {
    return oauthCallback(request, config);
  }
  if (path === "/token" && request.method === "POST") {
    return tokenExchange(request, config);
  }
  if (path === "/revoke" && request.method === "POST") return revokeToken(request, config);
  return null;
}

/**
 * Resolve a Bearer token that might be an OAuth access token.
 * Returns the underlying session string, or null if not found in KV.
 */
export async function resolveOAuthToken(
  bearer: string,
  kv: KVNamespace,
): Promise<OAuthTokenResolution | null> {
  const raw = await kv.get(`token:${bearer}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { session?: unknown; appId?: unknown; brokerRequestId?: unknown; familyId?: unknown };
    if (typeof data.session === "string" && data.session) {
      if (data.appId !== null && (typeof data.appId !== "string" || !APP_ID_RE.test(data.appId))) {
        return null;
      }
      const familyId = typeof data.familyId === "string" ? data.familyId : undefined;
      // A revoked grant (#457) kills its live access tokens, not just future refreshes.
      if (familyId && (await familyRevoked(kv, familyId))) return null;
      return {
        session: data.session,
        appId: data.appId,
        bound: true,
        ...(typeof data.brokerRequestId === "string" ? { brokerRequestId: data.brokerRequestId } : {}),
        ...(familyId ? { familyId } : {}),
      };
    }
  } catch {
    // Legacy entries stored the PAS session directly and have no OAuth
    // resource binding. Treat them as valid-looking but untrusted so callers can
    // force re-auth instead of silently widening an app-scoped grant.
  }
  return { session: raw, appId: null, bound: false };
}

/** Record that a broker credential reached a successful authenticated MCP route. */
export async function recordBrokerMcpRead(kv: KVNamespace, requestId: string): Promise<void> {
  await kv.put(`broker-read:${requestId}`, "1", { expirationTtl: 900 });
}

export async function brokerMcpReadSeen(kv: KVNamespace, requestId: string): Promise<boolean> {
  return (await kv.get(`broker-read:${requestId}`)) === "1";
}

// ── Internals ──────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || "";
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]!);
}

function authProvider(raw: string | null): AuthProvider | null {
  return AUTH_PROVIDERS.includes(raw as AuthProvider) ? raw as AuthProvider : null;
}

function configuredAuthProviders(config: OAuthConfig): AuthProvider[] {
  const providers = config.authProviders?.filter((provider) => AUTH_PROVIDERS.includes(provider));
  return providers?.length ? providers : [...AUTH_PROVIDERS];
}

function authStartUrl(config: OAuthConfig, nonce: string, provider: AuthProvider): string {
  const authUrl = new URL(config.authStart);
  if (provider !== "github") {
    authUrl.pathname = authUrl.pathname.replace("/auth/github/", `/auth/${provider}/`);
  }
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("app_id", "mcp");
  const callbackUrl = new URL("/oauth/callback", config.issuer);
  callbackUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("return_to", callbackUrl.toString());
  return authUrl.toString();
}

function appNameFromId(appId: string): string {
  return appId
    .split("-")
    .filter(Boolean)
    .map((part) => part === "crm" ? "CRM" : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function resourceTarget(resource: string | null, issuer: string): { ok: true; appId: string | null } | { ok: false } {
  if (!resource) return { ok: true, appId: null };
  try {
    const url = new URL(resource);
    const expected = new URL(issuer);
    if (url.origin !== expected.origin) return { ok: false };
    if (url.search || url.hash) return { ok: false };
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") return { ok: true, appId: null };
    const match = url.pathname.match(/^\/mcp\/apps\/([a-z][a-z0-9-]{0,57})\/?$/);
    if (match) return { ok: true, appId: match[1] };
  } catch {
    // fall through
  }
  return { ok: false };
}

function protectedResourceFromPath(path: string, issuer: string): string | null {
  if (
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return `${issuer}/mcp`;
  }
  const match = path.match(/^\/\.well-known\/oauth-protected-resource\/mcp\/apps\/([a-z][a-z0-9-]{0,57})\/?$/);
  if (!match) return null;
  return `${issuer}/mcp/apps/${match[1]}`;
}

function authConfirmPage(config: OAuthConfig, nonce: string, clientName: string | null, appId: string | null): Response {
  const continueUrl = (provider: AuthProvider) => {
    const url = new URL("/authorize/continue", config.issuer);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("provider", provider);
    return url.toString();
  };
  const name = clientName ? escapeHtml(clientName) : "your MCP client";
  const appName = appId ? appNameFromId(appId) : null;
  const productName = appName ? `${appName} MCP` : "ProAppStore MCP";
  const toolScope = appName ? `${appName} tools` : "ProAppStore MCP tools";
  const providerLinks = configuredAuthProviders(config).map((provider, index) => {
    const label = provider === "github" ? "GitHub" : "Google";
    const attrs = index === 0 ? " autofocus" : ' class="secondary"';
    return `<a${attrs} href="${escapeHtml(continueUrl(provider))}">Continue with ${label}</a>`;
  }).join("\n      ");
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect ${escapeHtml(productName)}</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#111827}
    main{max-width:440px;padding:32px;border:1px solid #e5e7eb;border-radius:12px;background:white;box-shadow:0 12px 32px rgba(15,23,42,.08)}
    h1{font-size:22px;margin:0 0 12px}
    p{line-height:1.5;margin:0 0 20px;color:#374151}
    .actions{display:flex;gap:10px;flex-wrap:wrap}
    a{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:8px;background:#7c3aed;color:white;text-decoration:none;font-weight:700}
    a.secondary{background:white;color:#374151;border:1px solid #d1d5db}
  </style>
</head>
<body>
  <main>
    <h1>Connect ${escapeHtml(productName)}</h1>
    <p>${name} wants to use ${escapeHtml(toolScope)} as your ProAppStore account.</p>
    <p>${appName
      ? "This authorizes the app's registered read and write actions, subject to your app permissions."
      : "This authorizes platform tools for your PAS apps: app data, source changes, provisioning, deployment, QA, ownership and Agent Teams. Starting agents can incur usage charges."}</p>
    <p>Access remains subject to PAS permissions. Refresh access lasts up to 90 days of inactivity. Revoke the connection through your MCP client; app-scoped grants can also be revoked from the app's MCP settings. Choose the account you intend to authorize.</p>
    <div class="actions">
      ${providerLinks}
    </div>
  </main>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": `${AUTH_NONCE_COOKIE}=${nonce}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** Native apps use loopback HTTP; all remote redirect URIs require HTTPS. */
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
    // RFC 8252 private-use schemes are based on a reverse domain name.
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol) && !u.host;
  } catch { return false; }
}

function redirectMatches(registered: string, supplied: string): boolean {
  if (registered === supplied) return true;
  if (!validRedirectUri(registered) || !validRedirectUri(supplied)) return false;
  const a = new URL(registered), b = new URL(supplied);
  if (a.protocol !== "http:" || b.protocol !== "http:" || a.hostname !== b.hostname) return false;
  // Loopback native clients select an available port at login (RFC 8252).
  a.port = ""; b.port = "";
  return a.href === b.href;
}

/** Fetch only trusted HTTPS client metadata, without credentials or redirects.
 * A domain policy avoids turning a public authorize URL into an SSRF proxy. */
async function clientMetadata(clientId: string, config: OAuthConfig): Promise<string | null> {
  try {
    const url = new URL(clientId);
    const hosts = config.clientMetadataHosts ?? ["chatgpt.com", "claude.ai"];
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || !hosts.includes(url.hostname)) return null;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const raw = await response.text();
    if (raw.length > 65_536) return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.client_id !== clientId || !Array.isArray(data.redirect_uris) || !data.redirect_uris.length ||
        data.redirect_uris.length > 20 || !data.redirect_uris.every(validRedirectUri) ||
        (data.client_name !== undefined && (typeof data.client_name !== "string" || data.client_name.length > 120)) ||
        (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none")) return null;
    const record = JSON.stringify({ client_id: clientId, redirect_uris: data.redirect_uris, client_name: data.client_name ?? null, token_endpoint_auth_method: "none" });
    await config.kv.put(`client:${clientId}`, record, { expirationTtl: 3600 });
    return record;
  } catch { return null; }
}

/** POST /register — dynamic client registration (required by mcp-remote) */
async function register(request: Request, config: OAuthConfig): Promise<Response> {
  // Rate limit: 20 registrations/hour/IP
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const hour = Math.floor(Date.now() / 3_600_000);
  const rlKey = `rl:reg:${ip}:${hour}`;
  const count = parseInt((await config.kv.get(rlKey)) ?? "0");
  if (count >= 20) {
    return json({ error: "rate_limit_exceeded" }, 429);
  }
  await config.kv.put(rlKey, String(count + 1), { expirationTtl: 3600 });

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 16_384) return json({ error: "invalid_request" }, 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "invalid_request" }, 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 20 || !redirectUris.every(validRedirectUri)) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }

  if ((body.client_name !== undefined && (typeof body.client_name !== "string" || body.client_name.length > 120)) ||
      (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none")) {
    return json({ error: "invalid_client_metadata" }, 400);
  }
  const clientId = crypto.randomUUID();
  const client = {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: body.client_name ?? null,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  await config.kv.put(`client:${clientId}`, JSON.stringify(client), {
    expirationTtl: 90 * 86_400, // 90 days
  });

  return json(client, 201);
}

/** GET /authorize — validate request, store auth state, redirect to PAS login */
async function authorize(request: Request, config: OAuthConfig): Promise<Response> {
  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const state = url.searchParams.get("state");
  const target = resourceTarget(url.searchParams.get("resource"), config.issuer);

  if (responseType !== "code") {
    return new Response("unsupported_response_type", { status: 400 });
  }
  if (!target.ok) {
    return new Response("invalid_target", { status: 400 });
  }
  if (!clientId || !redirectUri || !codeChallenge) {
    return new Response("missing client_id, redirect_uri, or code_challenge", { status: 400 });
  }
  if (clientId.length > 2048) return new Response("invalid client_id", { status: 400 });
  if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return new Response("only S256 is supported", { status: 400 });
  }
  // Verify client registration
  const clientRaw = await config.kv.get(`client:${clientId}`) ?? await clientMetadata(clientId, config);
  if (!clientRaw) {
    return new Response("invalid client_id", { status: 400 });
  }
  const client = JSON.parse(clientRaw) as { redirect_uris: string[]; client_name?: string | null };
  if (!client.redirect_uris.some((registered) => redirectMatches(registered, redirectUri))) {
    return new Response("redirect_uri not registered", { status: 400 });
  }

  // Store auth request (10-min TTL, single-use nonce)
  const nonce = crypto.randomUUID();
  await config.kv.put(
    `authreq:${nonce}`,
    JSON.stringify({ clientId, redirectUri, codeChallenge, state, appId: target.appId }),
    { expirationTtl: 600 },
  );

  return authConfirmPage(config, nonce, client.client_name ?? null, target.appId);
}

async function continueAuthorize(request: Request, config: OAuthConfig): Promise<Response> {
  const url = new URL(request.url);
  const nonce = url.searchParams.get("nonce");
  const provider = authProvider(url.searchParams.get("provider"));
  if (!nonce) return new Response("missing nonce", { status: 400 });
  if (!provider) return new Response("unsupported auth provider", { status: 400 });
  if (!configuredAuthProviders(config).includes(provider)) {
    return new Response("auth provider is not enabled", { status: 400 });
  }

  const reqRaw = await config.kv.get(`authreq:${nonce}`);
  if (!reqRaw) return new Response("invalid or expired nonce", { status: 400 });

  const authUrl = authStartUrl(config, nonce, provider);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
    },
  });
}

/** GET /oauth/callback — receives session token from PAS auth, issues auth code */
/**
 * Redeem a one-time login code for a PAS session token, server-to-server (#110).
 *
 * Derives the exchange URL from `authStart` rather than taking a new config
 * field, so every vendored copy of this file keeps working without a config
 * change in each MCP worker.
 *
 * Returns null on any failure; the caller then reports the same
 * "missing nonce or session" 400 an absent credential produces.
 */
async function exchangeLoginCode(config: OAuthConfig, code: string): Promise<string | null> {
  try {
    const exchangeUrl = new URL("/v1/auth/code/exchange", config.authStart);
    const api = config.api ?? globalThis;
    const response = await api.fetch(exchangeUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      token?: unknown;
      session?: unknown;
      sessionToken?: unknown;
    };
    const token = body.token ?? body.session ?? body.sessionToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

async function oauthCallback(request: Request, config: OAuthConfig): Promise<Response> {
  const url = new URL(request.url);
  const nonce = url.searchParams.get("nonce");
  const codeParam = url.searchParams.get("code");

  if (!nonce) {
    return new Response("missing nonce", { status: 400 });
  }
  if (!codeParam) {
    return new Response("missing code", { status: 400 });
  }

  // Browser binding: the nonce must match the cookie set at /authorize, proving
  // this is the same browser that started the flow. This mirrors the working
  // PAGS MCP flow and blocks login-CSRF / authorization-code injection.
  const cookieNonce = cookieValue(request, AUTH_NONCE_COOKIE);
  if (!cookieNonce || cookieNonce !== nonce) {
    return new Response("authorization flow not bound to this browser", { status: 400 });
  }

  // Retrieve the auth request BEFORE redeeming the platform login code. If the
  // nonce expired, do not burn the one-time code and turn the real problem into
  // a misleading "missing session" error.
  const reqRaw = await config.kv.get(`authreq:${nonce}`);
  if (!reqRaw) {
    return new Response("invalid or expired nonce", { status: 400 });
  }

  // SECURITY (#110): prefer a one-time code redeemed server-to-server over a
  // session token in the query string. A query parameter — unlike the fragment
  // the browser flow uses — reaches servers: Cloudflare request logs, Referer
  // headers, browser history. And `?session=` was a directly reusable Bearer
  // for the life of the session, which is exactly why OAuth returns a
  // short-lived single-use code in a redirect and why the implicit flow was
  // deprecated in OAuth 2.1.
  //
  // The `?session=` fallback is gone as of phase 3; a stale link carrying one
  // now fails rather than being honoured.
  const session = await exchangeLoginCode(config, codeParam);
  if (!session) {
    return new Response("invalid or expired code", { status: 400 });
  }

  // Consume auth request (single-use)
  await config.kv.delete(`authreq:${nonce}`);

  // Verify the session is valid
  const payload = await verifySession(session, config.sessionSigningKey);
  if (!payload) {
    return new Response("invalid session", { status: 400 });
  }

  const authReq = JSON.parse(reqRaw) as {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string | null;
    appId?: string | null;
  };

  // Generate single-use auth code (10-min TTL)
  const code = crypto.randomUUID();
  await config.kv.put(
    `code:${code}`,
    JSON.stringify({
      session,
      codeChallenge: authReq.codeChallenge,
      redirectUri: authReq.redirectUri,
      clientId: authReq.clientId,
      appId: authReq.appId ?? null,
    }),
    { expirationTtl: 600 },
  );

  // Redirect to client's redirect_uri with auth code
  const redirect = new URL(authReq.redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("iss", config.issuer);
  if (authReq.state) {
    redirect.searchParams.set("state", authReq.state);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": `${AUTH_NONCE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

/** POST /token — exchange auth code or refresh token for an access token */
async function tokenExchange(request: Request, config: OAuthConfig): Promise<Response> {
  let body: URLSearchParams;
  try {
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return json({ error: "invalid_request" }, 415);
    const raw = await request.text();
    if (raw.length > 16_384) return json({ error: "invalid_request" }, 413);
    body = new URLSearchParams(raw);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const grantType = body.get("grant_type");
  if (grantType === "refresh_token") {
    return refreshTokenGrant(body, config);
  }
  if (grantType !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }
  return authorizationCodeGrant(body, config);
}

/** grant_type=authorization_code — PKCE S256 verified, single-use code. */
async function authorizationCodeGrant(body: URLSearchParams, config: OAuthConfig): Promise<Response> {
  const code = body.get("code");
  const redirectUri = body.get("redirect_uri");
  const clientId = body.get("client_id");
  const codeVerifier = body.get("code_verifier");

  if (!code || !redirectUri || !clientId || !codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    return json({ error: "invalid_request" }, 400);
  }

  // Retrieve and consume auth code (single-use)
  const codeRaw = await config.kv.get(`code:${code}`);
  if (!codeRaw) {
    return json({ error: "invalid_grant" }, 400);
  }
  await config.kv.delete(`code:${code}`);

  const codeData = JSON.parse(codeRaw) as {
    session: string;
    codeChallenge: string;
    redirectUri: string;
    clientId: string;
    appId?: string | null;
  };

  const requested = body.get("resource");
  if (requested) {
    const target = resourceTarget(requested, config.issuer);
    if (!target.ok || target.appId !== (codeData.appId ?? null)) return json({ error: "invalid_target" }, 400);
  }
  if (codeData.redirectUri !== redirectUri || codeData.clientId !== clientId) {
    return json({ error: "invalid_grant" }, 400);
  }

  // Verify PKCE (S256): SHA-256(code_verifier) must equal code_challenge
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const computed = base64url(new Uint8Array(digest));

  if (computed !== codeData.codeChallenge) {
    return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  // Issue an opaque endpoint-bound access credential.
  const accessToken = crypto.randomUUID();
  const familyId = crypto.randomUUID();

  // Only a valid signed session can authorize a refresh family. Future refreshes
  // re-mint unprivileged claims; elevated roles remain bounded by this expiry.
  const claims = await verifySession(codeData.session, config.sessionSigningKey);
  if (!claims) return json({ error: "invalid_grant" }, 400);
  const refreshToken = await issueRefreshToken(config, {
    claims: sessionSeed(claims), clientId, appId: codeData.appId ?? null,
    familyId, privilegedUntil: claims.exp,
  });
  const expiresIn = Math.min(86_400, claims.exp - Math.floor(Date.now() / 1000));
  // The access token carries its family only when a grant exists to revoke (#457).
  await config.kv.put(
    `token:${accessToken}`,
    JSON.stringify({ session: codeData.session, appId: codeData.appId ?? null, familyId, clientId }),
    { expirationTtl: expiresIn },
  );
  await writeGrant(config, claims.uid, codeData.appId ?? null, familyId, clientId);

  return json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
  });
}

interface RefreshTokenRecord {
  /** Session claims to re-mint from, minus iat/exp (always fresh on rotation). */
  claims: NewSession;
  /** Public PKCE client this token is bound to (#418). */
  clientId: string;
  appId: string | null;
  /** Shared by every token descended from one authorization — reuse revokes it all. */
  familyId: string;
  /** Set once this token has been redeemed; a second redemption is reuse. */
  usedAt: number | null;
  /** Epoch seconds. Reset to +refreshTokenTtlSeconds on every rotation (sliding window). */
  expiresAt: number;
  /**
   * Epoch seconds: the authorizing session's own `exp`. Roles beyond
   * {@link UNPRIVILEGED_ROLES} are granted at sign-in (the backend's rolesFor) and
   * never re-checked, so a refresh after this mints without them (#429): an admin
   * removed from ADMIN_GITHUB_IDS loses admin over MCP when the session they
   * signed in with would have expired, as before refresh tokens. Absent on
   * records issued before this field: treated as already past.
   */
  privilegedUntil?: number;
  /** Stored only after a successful rotation, for bounded idempotent retries. */
  rotation?: RotationResponse;
}

/** Roles every signed-in account holds (backend rolesFor); anything else is a grant that must be re-checked by signing in. */
const UNPRIVILEGED_ROLES = new Set(["user", "creator"]);

/** The claims a refresh mints from: privileged roles dropped once the authorizing session would have expired. */
function refreshClaims(record: RefreshTokenRecord, now: number): NewSession {
  if ((record.privilegedUntil ?? 0) > now) return record.claims;
  const roles = (record.claims.roles ?? []).filter((r) => UNPRIVILEGED_ROLES.has(r));
  return { ...record.claims, roles };
}

/** grant_type=refresh_token — rotates on every use; reuse revokes the family. */
async function refreshTokenGrant(body: URLSearchParams, config: OAuthConfig): Promise<Response> {
  const refreshToken = body.get("refresh_token");
  const clientId = body.get("client_id");
  if (!refreshToken || !clientId) {
    return json({ error: "invalid_request" }, 400);
  }

  const key = `refresh:${refreshToken}`;
  const raw = await config.kv.get(key);
  if (!raw) {
    return json({ error: "invalid_grant" }, 400);
  }
  const record = JSON.parse(raw) as RefreshTokenRecord;
  const now = Math.floor(Date.now() / 1000);

  if (record.clientId !== clientId) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (record.expiresAt <= now) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (await familyRevoked(config.kv, record.familyId)) {
    return json({ error: "invalid_grant" }, 400);
  }
  const resource = body.get("resource");
  if (resource) {
    const target = resourceTarget(resource, config.issuer);
    if (!target.ok || target.appId !== record.appId) return json({ error: "invalid_target" }, 400);
  }
  if (record.usedAt !== null) {
    if (record.rotation && record.usedAt + REFRESH_RETRY_SECONDS >= now) return json({ ...record.rotation, expires_in: Math.max(0, record.rotation.expires_in - (now - record.usedAt)) });
    // This token was already rotated away. Someone is replaying an old one —
    // kill the whole family, including whatever token it was rotated into.
    await revokeFamily(config, record.familyId);
    return json({ error: "invalid_grant" }, 400);
  }

  // Re-mint the session fresh (#418): this is what makes the refresh work for
  // the full 90 days even though the underlying session JWT's own TTL is 30
  // days — we never read its exp, only the claims it was minted with.
  const claims = refreshClaims(record, now);
  const privileged = (claims.roles ?? []).some((role) => !UNPRIVILEGED_ROLES.has(role));
  const sessionTtl = privileged ? Math.max(1, Math.min(30 * 86_400, (record.privilegedUntil ?? now) - now)) : 30 * 86_400;
  const expiresIn = Math.min(86_400, sessionTtl);
  const session = await mintSession(claims, config.sessionSigningKey, sessionTtl);
  const accessToken = crypto.randomUUID();
  await config.kv.put(
    `token:${accessToken}`,
    JSON.stringify({ session, appId: record.appId, familyId: record.familyId, clientId: record.clientId }),
    { expirationTtl: expiresIn },
  );
  await touchGrant(config, claims.uid, record.appId, record.familyId, record.clientId);
  const nextRefreshToken = await issueRefreshToken(config, {
    claims,
    clientId: record.clientId,
    appId: record.appId,
    familyId: record.familyId,
    privilegedUntil: record.privilegedUntil,
  });

  const rotation: RotationResponse = {
    access_token: accessToken, token_type: "bearer", expires_in: expiresIn, refresh_token: nextRefreshToken,
  };
  // Publish the successor before spending its parent. A failed mint/write never
  // strands the client, and a lost response can recover the SAME pair briefly.
  await config.kv.put(key, JSON.stringify({ ...record, usedAt: now, rotation }), {
    expirationTtl: Math.max(60, record.expiresAt - now),
  });
  return json(rotation);
}

function sessionSeed(claims: { iat: number; exp: number } & NewSession): NewSession {
  const { iat: _iat, exp: _exp, ...seed } = claims;
  return seed;
}

async function issueRefreshToken(
  config: Pick<OAuthConfig, "kv" | "refreshTokenTtlSeconds">,
  input: { claims: NewSession; clientId: string; appId: string | null; familyId: string; privilegedUntil?: number },
): Promise<string> {
  const ttlSeconds = config.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
  const token = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const record: RefreshTokenRecord = {
    claims: input.claims,
    clientId: input.clientId,
    appId: input.appId,
    familyId: input.familyId,
    usedAt: null,
    expiresAt,
    ...(input.privilegedUntil !== undefined ? { privilegedUntil: input.privilegedUntil } : {}),
  };
  await config.kv.put(`refresh:${token}`, JSON.stringify(record), { expirationTtl: ttlSeconds });
  return token;
}

async function familyRevoked(kv: KVNamespace, familyId: string): Promise<boolean> {
  return (await kv.get(`revoked-refresh-family:${familyId}`)) === "1";
}

async function revokeFamily(
  config: Pick<OAuthConfig, "kv" | "refreshTokenTtlSeconds">,
  familyId: string,
): Promise<void> {
  const ttlSeconds = config.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
  await config.kv.put(`revoked-refresh-family:${familyId}`, "1", { expirationTtl: ttlSeconds });
}

/** RFC 7009: a public client can revoke only credentials issued to that client.
 * Unknown tokens and tokens belonging to another client have the same response. */
async function revokeToken(request: Request, config: OAuthConfig): Promise<Response> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return json({ error: "invalid_request" }, 415);
  const raw = await request.text();
  if (raw.length > 16_384) return json({ error: "invalid_request" }, 413);
  const body = new URLSearchParams(raw);
  const token = body.get("token"), clientId = body.get("client_id");
  if (!token || !clientId) return json({ error: "invalid_request" }, 400);
  const refresh = await config.kv.get(`refresh:${token}`);
  const access = refresh ? null : await config.kv.get(`token:${token}`);
  let record: (RefreshTokenRecord & { session?: string }) | null;
  try { record = JSON.parse(refresh ?? access ?? "null"); }
  catch { record = null; }
  if (record?.clientId === clientId && typeof record.familyId === "string") {
    // Storage failures propagate; they must not masquerade as successful revocation.
    await revokeFamily(config, record.familyId);
    const uid = record.claims?.uid ?? (record.session ? (await verifySession(record.session, config.sessionSigningKey))?.uid : undefined);
    if (uid) await config.kv.delete(grantKey(uid, record.appId, record.familyId));
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store", "Pragma": "no-cache", "Access-Control-Allow-Origin": "*" } });
}

// ── Grants (#457) ────────────────────────────────────────────────────────────
// One record per authorization (family), keyed by account and endpoint so one
// account's grants can be listed and revoked without scanning anyone else's.
// Holds no token and no session: only what the console shows.

export interface McpGrant {
  /** The family id: opaque, the handle for revoking. */
  id: string;
  client_name: string | null;
  /** `app` when bound to one /mcp/apps/<id> endpoint, `shared` for the /mcp endpoint. */
  scope: "app" | "shared";
  app_id: string | null;
  created_at: number;
  /** Epoch seconds of the last token issued from this grant (sign-in or refresh). */
  last_used_at: number;
}

const grantKey = (uid: string, appId: string | null, familyId: string) => `grant:${uid}:${appId ?? "_"}:${familyId}`;

async function writeGrant(
  config: Pick<OAuthConfig, "kv" | "refreshTokenTtlSeconds">,
  uid: string,
  appId: string | null,
  familyId: string,
  clientId: string,
  createdAt?: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let clientName: string | null = null;
  try {
    const raw = await config.kv.get(`client:${clientId}`);
    const name = raw ? (JSON.parse(raw) as { client_name?: unknown }).client_name : null;
    clientName = typeof name === "string" ? name.slice(0, 120) : null;
  } catch { /* the label is cosmetic */ }
  const record = { client_name: clientName, created_at: createdAt ?? now, last_used_at: now };
  await config.kv.put(grantKey(uid, appId, familyId), JSON.stringify(record), {
    expirationTtl: config.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS,
  });
}

/** A refresh renews the grant's last-used time. A revoked (deleted) grant is not resurrected. */
async function touchGrant(
  config: Pick<OAuthConfig, "kv" | "refreshTokenTtlSeconds">,
  uid: string,
  appId: string | null,
  familyId: string,
  clientId: string,
): Promise<void> {
  const raw = await config.kv.get(grantKey(uid, appId, familyId));
  if (!raw) {
    // Families issued before grants were indexed gain a record on their next refresh.
    if (await familyRevoked(config.kv, familyId)) return;
    await writeGrant(config, uid, appId, familyId, clientId);
    return;
  }
  let createdAt: number | undefined;
  try { createdAt = (JSON.parse(raw) as { created_at?: number }).created_at; } catch { /* rewritten below */ }
  await writeGrant(config, uid, appId, familyId, clientId, createdAt);
}

/** One account's grants on one endpoint (`appId` null = the shared /mcp endpoint). Never holds a credential. */
export async function listGrants(kv: KVNamespace, uid: string, appId: string | null): Promise<McpGrant[]> {
  const prefix = `grant:${uid}:${appId ?? "_"}:`;
  const out: McpGrant[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const { name } of page.keys) {
      const id = name.slice(prefix.length);
      if (!id || id.includes(":")) continue;
      const raw = await kv.get(name);
      if (!raw) continue;
      try {
        const g = JSON.parse(raw) as { client_name?: unknown; created_at?: unknown; last_used_at?: unknown };
        out.push({
          id,
          client_name: typeof g.client_name === "string" ? g.client_name : null,
          scope: appId ? "app" : "shared",
          app_id: appId,
          created_at: Number(g.created_at) || 0,
          last_used_at: Number(g.last_used_at) || 0,
        });
      } catch { /* skip a malformed record */ }
    }
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);
  return out.sort((a, b) => b.last_used_at - a.last_used_at);
}

/**
 * Revoke one of an account's grants: its refresh family is flagged (so no refresh
 * and no already-issued access token resolves again) and the record is removed.
 * Only the owning account's grants are looked up, so a foreign id is a no-op.
 * Returns whether a grant was found.
 */
export async function revokeGrant(
  config: Pick<OAuthConfig, "kv" | "refreshTokenTtlSeconds">,
  uid: string,
  grantId: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(grantId)) return false;
  const prefix = `grant:${uid}:`;
  let cursor: string | undefined;
  do {
    const page = await config.kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const { name } of page.keys) {
      if (!name.endsWith(`:${grantId}`) || name.slice(prefix.length).split(":").length !== 2) continue;
      await revokeFamily(config, grantId);
      await config.kv.delete(name);
      return true;
    }
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);
  return false;
}
