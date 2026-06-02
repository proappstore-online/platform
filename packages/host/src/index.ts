/**
 * proappstore-host — serves every published app from R2 via subdomain routing.
 *
 *   ┌────────────────────────────────────────────────────────────────────────┐
 *   │  user visits  meetup.proappstore.online/  ────▶  Wildcard route        │
 *   │                                              │                          │
 *   │                                              ▼                          │
 *   │                                  this Worker (proappstore-host)         │
 *   │                                              │                          │
 *   │  1. slugFromHostname()                                                   │
 *   │  2. if RESERVED → dispatch via service binding (ADMIN / API)             │
 *   │  3. else → lookup route in D1 → R2.get(apps/{slug}/{path})              │
 *   │              + content-type, cache headers, etag handling                │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Wildcard pattern (NOT path-based) — every app gets its own subdomain
 * URL identity. Mirrors fas/host. Per `wildcard-worker-route-preemption`
 * memory: enabling `*.proappstore.online/*` preempts every sibling Worker
 * custom_domain on this zone, so this Worker MUST dispatch reserved
 * subdomains (admin, api, etc.) via service bindings instead of letting
 * the original Workers respond.
 *
 * v0.1: only /health on the apex subdomain check and a 501 catch-all.
 * Stage 0 wires R2, DB, and service bindings; ports the dispatch + serve
 * logic from fas/host.
 */

import type { Env } from "./env.js";
import { RESERVED_SUBDOMAINS, slugFromHostname } from "./host.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        worker: "proappstore-host",
        version: "0.1.0",
        stage: "scaffold",
      });
    }

    const slug = slugFromHostname(url.hostname);

    if (slug === null) {
      return new Response("Not found", { status: 404 });
    }

    if (RESERVED_SUBDOMAINS.has(slug)) {
      // Stage 0 wires service-binding dispatch here:
      //   if (slug === "admin") return env.ADMIN.fetch(request);
      //   if (slug === "api")   return env.API.fetch(request);
      return Response.json(
        { error: "not_implemented", stage: "scaffold", reserved: slug },
        { status: 501 },
      );
    }

    // Stage 0: lookup slug in routes table → resolve r2_prefix → serve from R2.
    // Suppress unused-warning until then.
    void env;
    void ctx;

    return Response.json(
      { error: "not_implemented", stage: "scaffold", slug, path: url.pathname },
      { status: 501 },
    );
  },
};
