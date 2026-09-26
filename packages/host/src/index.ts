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
import { handleQaRunner } from "./qa-runner.js";
import {
  contentType,
  etagsMatch,
  getListingMeta,
  getPageMeta,
  getSitemapAction,
  getSitemapUrls,
  getTenantMeta,
  isBlockedAssetPath,
  isUpdateSensitivePath,
  r2KeyFor,
  renderSitemap,
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
    if (slug === "api") {
      // X-PAS-App is this worker's assertion of which app a *mediated* request
      // came from (platform-mediation.ts), and the backend's secret proxy binds
      // calls to it (#80). A caller hitting the API directly must not be able to
      // say it for us.
      const direct = new Request(request);
      direct.headers.delete("X-PAS-App");
      return env.API.fetch(direct);
    }
    if (slug === "admin") return env.ADMIN.fetch(request);
    if (slug === "agents") return env.AGENTS.fetch(request);
    if (slug === "mcp") return env.MCP.fetch(request);
    if (slug === "kb") return env.KB.fetch(request);
    if (slug === "docs") return env.KB.fetch(request);

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

    // data-* → proxy to per-app D1 Workers (dynamically created, no static
    // binding). This is the BROWSER path only — cookie mediation lands here.
    // Backend-internal calls (actions, /validate, provisioning) never come
    // through this hop; they use DATA_WORKER_HOST directly (#153).
    if (slug?.startsWith("data-")) {
      if (!env.DATA_WORKER_HOST) {
        return new Response("DATA_WORKER_HOST is not configured", { status: 503 });
      }
      return fetch(
        new Request(
          `https://pas-${slug}.${env.DATA_WORKER_HOST}${url.pathname}${url.search}`,
          request,
        ),
      );
    }

    // ── App serving from R2 ──────────────────────────────────────

    const route = await resolveRouteForHostname(env.DB, url.hostname);
    if (!route) {
      return new Response("App not found", { status: 404 });
    }

    if (route.matched === "wildcard" && route.tenant === "www" && route.base) {
      return Response.redirect(`https://${route.base}${url.pathname}${url.search}`, 301);
    }

    const authResponse = await handleAuthRoute(request, env, route);
    if (authResponse) return authResponse;

    const mediationResponse = await handlePlatformMediation(request, env, route);
    if (mediationResponse) return mediationResponse;

    // Observable QA runner (#38) — platform page on the app's own origin;
    // data access is enforced by the /.pas/api cookie mediation.
    const qaResponse = handleQaRunner(request, route);
    if (qaResponse) return qaResponse;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Never serve source maps, whatever an app uploaded (see isBlockedAssetPath).
    // Checked before the edge cache so a previously-cached map cannot keep being
    // served after this deploy, and answered as 404 rather than 403 so the
    // response does not confirm the file exists.
    if (isBlockedAssetPath(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    // Edge cache check — serve from cache if available (avoids R2 + D1 on every hit)
    const cache = (caches as unknown as { default: Cache }).default;
    const skipEdgeCache = isUpdateSensitivePath(url.pathname);
    if (request.method === "GET" && !skipEdgeCache) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    // Generated sitemap (#210) when the app declares one; otherwise fall through,
    // so an app that ships a static sitemap.xml keeps serving it.
    if (url.pathname === "/sitemap.xml") {
      const action = await getSitemapAction(env.DB, route.slug);
      if (action) {
        const urls = await getSitemapUrls(env.API, route.slug, action);
        if (!urls) {
          // A failing action must not publish, or cache, an empty sitemap.
          return new Response("Sitemap temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "300" } });
        }
        const sitemap = new Response(request.method === "HEAD" ? null : renderSitemap(url.origin, urls), {
          headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
        });
        if (request.method === "GET") ctx.waitUntil(cache.put(request, sitemap.clone()));
        return sitemap;
      }
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

    // The console's Code Health panel fetches /.vcqa/report.json (+ badge.svg)
    // cross-origin (console origin ≠ <app>.proappstore.online), so without CORS the
    // browser blocks the read → "Failed to fetch". The report is already publicly
    // served (no auth), so allowing cross-origin reads exposes nothing new.
    if (url.pathname.startsWith("/.vcqa/")) {
      headers.set("Access-Control-Allow-Origin", "*");
    }

    const body = request.method === "HEAD" ? null : object.body;
    let response = new Response(body, { status: 200, headers });

    // Inject crawler-visible metadata. App HTML remains the title source by
    // default; app listing metadata supplies fallback image/description,
    // wildcard tenant hosts can override title/image from public org branding,
    // and a declared page_meta route overrides all three for its path (#210).
    // Each lookup fails open; the result is cached with the page below.
    if (isHtml && request.method === "GET") {
      const [listing, tenant, page] = await Promise.all([
        getListingMeta(env.DB, route.slug),
        getTenantMeta(env.API, route.slug, route.tenant),
        getPageMeta(env.DB, env.API, route.slug, url.pathname),
      ]);
      response = rewriteMetaTags(response, {
        title: page?.title ?? tenant?.title ?? null,
        tagline: page?.description ?? listing?.tagline ?? null,
        icon_url: page?.image_url ?? tenant?.icon_url ?? listing?.icon_url ?? null,
      }, `${url.origin}${url.pathname}`);
    }

    // Edge cache: store the response so next request skips R2 + D1. GET only:
    // the Cache API refuses a non-GET request ("Cannot cache response to
    // non-GET request"), which surfaced on HEAD as an uncaught exception in
    // waitUntil once the host ran under workerd in the runtime suite (#23).
    if (!skipEdgeCache && !updateSensitive && request.method === "GET") {
      ctx.waitUntil(cache.put(request, response.clone()));
    }

    return response;
  },
};
