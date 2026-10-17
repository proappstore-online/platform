import type { Env } from "./env.js";
import { contentType, etagsMatch } from "./host.js";

interface MarketingState {
  active_revision: string | null;
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A static, zero-JS site: tighter than the runnable app's policy. Nothing may
 * frame it, run a script from elsewhere or submit a form; the JSON-LD block is
 * data, not script. Every response revalidates (no edge cache, `max-age=0`),
 * so a revision switch or an unpublish is seen on the very next request.
 */
const MARKETING_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

function marketingHeaders(path: string, revision: string): Headers {
  const h = new Headers();
  h.set("Content-Type", contentType(path));
  h.set("Cache-Control", "public, max-age=0, must-revalidate");
  h.set("Content-Security-Policy", MARKETING_CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  // Which immutable revision answered: the deploy receipt's live observation.
  h.set("X-PAS-Marketing-Revision", revision);
  return h;
}

function assetPath(pathname: string): string | null {
  if (pathname === "/") return "index.html";
  if (!["/index.html", "/robots.txt", "/sitemap.xml"].includes(pathname)
    && !/^\/(?:_astro|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pathname)) return null;
  if (pathname.split("/").some((part) => part === "." || part === ".." || part.startsWith("."))) return null;
  if (/\.map$/i.test(pathname) || pathname.includes("//")) return null;
  return pathname.slice(1);
}

/** The marketing origin is independent of the runnable app and fails closed. */
export async function serveMarketingSite(request: Request, env: Env, appId: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: NO_STORE });
  }
  const path = assetPath(new URL(request.url).pathname);
  if (!path || !/^[a-z0-9](?:[a-z0-9-]{0,55}[a-z0-9])?$/.test(appId)) {
    return new Response("Not found", { status: 404, headers: NO_STORE });
  }

  let state: MarketingState | null;
  try {
    state = await env.DB.prepare(
      // #409: every app's marketing site is public, private apps included —
      // it is served whenever the app has an active revision. Neither the
      // app's visibility nor its storefront listing gates it.
      `SELECT m.active_revision
       FROM apps a
       JOIN app_marketing_sites m ON m.app_id = a.id
       WHERE a.id = ?1`,
    ).bind(appId).first<MarketingState>();
  } catch (error) {
    // During migration rollout an absent table must never expose app files.
    if (/no such table:/i.test(String(error))) return new Response("Not found", { status: 404, headers: NO_STORE });
    return new Response("Site temporarily unavailable", { status: 503, headers: NO_STORE });
  }
  const revision = state?.active_revision;
  if (!revision || !/^[A-Za-z0-9_-]{1,80}$/.test(revision)) {
    return new Response("Not found", { status: 404, headers: NO_STORE });
  }

  let object: R2ObjectBody | null;
  try {
    object = await env.APPS.get(`marketing/${appId}/revisions/${revision}/${path}`);
  } catch {
    return new Response("Site temporarily unavailable", {
      status: 503,
      headers: { ...NO_STORE, "Retry-After": "30" },
    });
  }
  if (!object) return new Response("Not found", { status: 404, headers: NO_STORE });

  const headers = marketingHeaders(path, revision);
  headers.set("ETag", object.httpEtag);
  if (!path.endsWith(".html")) headers.set("Content-Length", String(object.size));
  if (etagsMatch(request.headers.get("If-None-Match"), object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
