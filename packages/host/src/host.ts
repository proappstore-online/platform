/**
 * Subdomain parsing + R2 routing helpers for proappstore-host.
 *
 * v0.1: only slugFromHostname. Stage 0 adds:
 *   - r2KeyFor(slug, path)
 *   - contentType(path)
 *   - etagsMatch(req, etag)
 *   - securityHeaders(slug)
 *   - isVisible(routeRecord) — gated by registry status (public / pending / rejected)
 *
 * Mirror of fas/host/src/host.ts (R2-backed wildcard pattern) — NOT of
 * fws/host/src/host.ts (which is path-based at a single hostname).
 */

/**
 * Extract the subdomain "slug" from a hostname.
 *
 * `meetup.proappstore.online`   → "meetup"
 * `carsads.proappstore.online`  → "carsads"
 * `proappstore.online`          → null  (apex — not handled by this Worker)
 * `admin.proappstore.online`    → "admin" (caller must dispatch via ADMIN binding)
 * `api.proappstore.online`      → "api"   (caller must dispatch via API binding)
 *
 * Returns null for anything that isn't a single-level subdomain under
 * proappstore.online. Multi-level (`a.b.proappstore.online`) returns null —
 * not supported in v1.
 */
export function slugFromHostname(hostname: string): string | null {
  const base = ".proappstore.online";
  if (!hostname.endsWith(base)) return null;
  const slug = hostname.slice(0, -base.length);
  if (slug.length === 0) return null;        // apex
  if (slug.includes(".")) return null;        // multi-level subdomain
  return slug;
}

// Reserved subdomains that this Worker MUST dispatch via service bindings
// rather than serve from R2. Keeping the list explicit (not pattern-based)
// makes additions a code review event, which is the right level of friction
// for "what hostnames does my platform expose."
export const RESERVED_SUBDOMAINS = new Set<string>([
  "admin",   // pas/admin Worker
  "api",     // pas/platform/packages/backend
  "www",     // future: redirect to apex
  "agents",  // future: pas/platform/packages/agent-teams Worker
  // data-* (per-app D1 worker) handled separately via prefix match in index.ts
]);
