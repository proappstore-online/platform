/**
 * proappstore-host — serves every published Pro app from R2 via subdomain routing.
 *
 * Wildcard route `*.proappstore.online/*` catches all subdomains. Reserved
 * subdomains (api, admin, agents, mcp, kb, docs, console, dashboard) are
 * dispatched via service bindings or proxied to CF Pages. Everything else is looked up
 * in the D1 routes table and served from R2.
 *
 * data-* subdomains (per-app D1 Workers) are proxied via fetch since they're
 * dynamically created and can't have static service bindings.
 */

import type { Env } from "./env.js";
import { handleAuthRoute } from "./auth-handler.js";
import { handlePlatformMediation } from "./platform-mediation.js";
import {
  contentType,
  etagsMatch,
  getListingMeta,
  isUpdateSensitivePath,
  r2KeyFor,
  resolveRouteForHostname,
  securityHeaders,
  slugFromHostname,
} from "./host.js";
import { rewriteMetaTags } from "./meta-rewriter.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check (any hostname)
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "proappstore-host", version: "1.0.0" });
    }

    const slug = slugFromHostname(url.hostname);

    // ── Reserved subdomain dispatch ──────────────────────────────

    // Service-bound Workers (zero-hop, no external fetch)
    if (slug === "api") return env.API.fetch(request);
    if (slug === "admin") return env.ADMIN.fetch(request);
    if (slug === "agents") return env.AGENTS.fetch(request);
    if (slug === "mcp") return env.MCP.fetch(request);
    if (slug === "kb") return env.KB.fetch(request);
    if (slug === "docs") return env.KB.fetch(request);
    if (slug === "build") return env.BUILD.fetch(request);

    // www → redirect to apex
    if (slug === "www") {
      return Response.redirect(`https://proappstore.online${url.pathname}${url.search}`, 301);
    }

    // Console + Dashboard → proxy to CF Pages (can't service-bind Pages projects)
    if (slug === "console")
      return fetch(
        new Request(`https://proappstore-console.pages.dev${url.pathname}${url.search}`, request),
      );
    if (slug === "dashboard")
      return fetch(
        new Request(`https://proappstore-dashboard.pages.dev${url.pathname}${url.search}`, request),
      );

    // data-* → proxy to per-app D1 Workers (dynamically created, no static binding)
    if (slug?.startsWith("data-")) {
      return fetch(
        new Request(
          `https://pas-${slug}.serge-the-dev.workers.dev${url.pathname}${url.search}`,
          request,
        ),
      );
    }

    // ── App serving from R2 ──────────────────────────────────────

    const route = await resolveRouteForHostname(env.DB, url.hostname);
    if (!route) {
      return new Response("App not found", { status: 404 });
    }

    const authResponse = await handleAuthRoute(request, env, route);
    if (authResponse) return authResponse;

    const mediationResponse = await handlePlatformMediation(request, env, route);
    if (mediationResponse) return mediationResponse;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Edge cache check — serve from cache if available (avoids R2 + D1 on every hit)
    const cache = (caches as unknown as { default: Cache }).default;
    const skipEdgeCache = isUpdateSensitivePath(url.pathname);
    if (request.method === "GET" && !skipEdgeCache) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    // Compute the R2 key
    let key = r2KeyFor(route, url.pathname);
    let object = await env.APPS.get(key);

    // SPA fallback: if the path has no file extension and the key misses R2,
    // fall back to index.html (React Router, etc.)
    const hasExtension = url.pathname.split("/").pop()?.includes(".") ?? false;
    if (!object && !hasExtension) {
      key = `${route.r2_prefix}/index.html`;
      object = await env.APPS.get(key);
    }

    if (!object) {
      return new Response("Not found", { status: 404 });
    }

    // 304 Not Modified
    const etag = object.httpEtag;
    if (etagsMatch(request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    // Serve the object
    const isHtml = key.endsWith(".html");
    const updateSensitive = isUpdateSensitivePath(key);
    const headers = securityHeaders(isHtml, updateSensitive);
    headers.set("Content-Type", contentType(key));
    headers.set("ETag", etag);
    if (!isHtml && object.size !== undefined) headers.set("Content-Length", String(object.size));

    const body = request.method === "HEAD" ? null : object.body;
    let response = new Response(body, { status: 200, headers });

    // Inject per-app meta tags from app_listings (og:image, og:description, favicon)
    if (isHtml && request.method === "GET") {
      const listing = await getListingMeta(env.DB, route.slug);
      if (listing?.icon_url || listing?.tagline) {
        response = rewriteMetaTags(response, listing);
      }
    }

    // Edge cache: store the response so next request skips R2 + D1
    if (!skipEdgeCache && !updateSensitive) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }

    return response;
  },
};
