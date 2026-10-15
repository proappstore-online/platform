import type { Env } from "./env.js";
import { contentType, etagsMatch, securityHeaders } from "./host.js";

interface MarketingState {
  listed: number;
  active_revision: string | null;
  visibility_mode: string | null;
}

const NO_STORE = { "Cache-Control": "no-store" };

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
      `SELECT p.listed, m.active_revision, v.mode AS visibility_mode
       FROM apps a
       JOIN app_storefront_publication p ON p.app_id = a.id
       JOIN app_marketing_sites m ON m.app_id = a.id
       LEFT JOIN app_visibility v ON v.app_id = a.id
       WHERE a.id = ?1`,
    ).bind(appId).first<MarketingState>();
  } catch (error) {
    // During migration rollout an absent table must never expose app files.
    if (/no such table:/i.test(String(error))) return new Response("Not found", { status: 404, headers: NO_STORE });
    return new Response("Site temporarily unavailable", { status: 503, headers: NO_STORE });
  }
  const revision = state?.active_revision;
  if (state?.listed !== 1 || state.visibility_mode === "private" || !revision
    || !/^[A-Za-z0-9_-]{1,80}$/.test(revision)) {
    return new Response("Not found", { status: 404, headers: NO_STORE });
  }

  const object = await env.APPS.get(`marketing/${appId}/revisions/${revision}/${path}`);
  if (!object) return new Response("Not found", { status: 404, headers: NO_STORE });

  const headers = securityHeaders(path.endsWith(".html"), true);
  headers.set("Content-Type", contentType(path));
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("ETag", object.httpEtag);
  if (!path.endsWith(".html")) headers.set("Content-Length", String(object.size));
  if (etagsMatch(request.headers.get("If-None-Match"), object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
