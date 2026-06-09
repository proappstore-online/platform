/**
 * Subdomain parsing + R2 serving helpers for proappstore-host.
 * Vendored from fas/host/src/host.ts with PAS-specific CSP/zones.
 */

const ZONE = ".proappstore.online";

export interface Route {
  slug: string;
  zone: string;
  r2_prefix: string;
  store: string;
}

/**
 * Extract the subdomain slug from a hostname.
 * Returns null for apex, multi-level subdomains, or non-proappstore hosts.
 */
export function slugFromHostname(hostname: string): string | null {
  const h = hostname.toLowerCase().split(":")[0]!;
  if (!h.endsWith(ZONE)) return null;
  const slug = h.slice(0, -ZONE.length);
  if (slug.length === 0) return null; // apex
  if (slug.includes(".")) return null; // multi-level
  return slug;
}

/** Reserved subdomains dispatched via service bindings, not served from R2. */
export const RESERVED_SUBDOMAINS = new Set([
  "admin",
  "api",
  "agents",
  "mcp",
  "kb",
  "www",
  "console",
  "dashboard",
]);

/** Look up a route from D1. Returns null if no matching row. */
export async function resolveRoute(db: D1Database, slug: string): Promise<Route | null> {
  return db
    .prepare("SELECT slug, zone, r2_prefix, store FROM routes WHERE slug = ?1 AND zone = ?2")
    .bind(slug, "proappstore.online")
    .first<Route>();
}

/** Map a route + URL pathname to an R2 object key. */
export function r2KeyFor(route: Route, pathname: string): string {
  let p = pathname;
  if (p === "" || p === "/" || p.endsWith("/")) p += "index.html";
  return `${route.r2_prefix}/${p.replace(/^\/+/, "")}`;
}

/** Check if a request's If-None-Match header matches an R2 object's ETag. */
export function etagsMatch(headerValue: string | null, objectEtag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  return trimmed.split(",").some((t) => t.trim() === objectEtag);
}

/** Map file extension to MIME type. */
export function contentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff2: "font/woff2",
    woff: "font/woff",
    webmanifest: "application/manifest+json",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Files with stable names must remain updateable across app deploys. */
export function isUpdateSensitivePath(pathname: string): boolean {
  const name = pathname.split("/").pop()?.toLowerCase() ?? "";
  return name === "sw.js" || name === "registersw.js" || name === "manifest.webmanifest";
}

/** Security + cache headers. HTML and update-sensitive files get short cache; hashed assets get immutable. */
export function securityHeaders(isHtml: boolean, updateSensitive = false): Headers {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(self), camera=(), microphone=(), payment=()");
  h.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://api.proappstore.online https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://api.proappstore.online https://*.proappstore.online wss://api.proappstore.online wss://*.proappstore.online https://fonts.googleapis.com https://fonts.gstatic.com https://cloudflareinsights.com",
      "frame-ancestors 'self' https://proappstore.online https://*.proappstore.online",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  h.set(
    "Cache-Control",
    isHtml || updateSensitive
      ? "public, max-age=0, s-maxage=60, must-revalidate"
      : "public, max-age=31536000, immutable",
  );
  return h;
}
