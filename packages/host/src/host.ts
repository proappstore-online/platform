/**
 * Subdomain parsing + R2 serving helpers for proappstore-host.
 * Vendored from fas/host/src/host.ts with PAS-specific CSP/zones.
 */

const ZONE = ".proappstore.online";
const PLATFORM_ZONE = "proappstore.online";

export interface Route {
  slug: string;
  zone: string;
  r2_prefix: string;
  store: string;
}

export interface ResolvedRoute extends Route {
  matched: "platform" | "exact" | "wildcard";
  tenant?: string;
  base?: string;
}

/** Listing metadata used by HTMLRewriter for social/SEO meta tag injection. */
export interface ListingMeta {
  icon_url: string | null;
  tagline: string | null;
}

/** Public tenant branding used for wildcard custom-domain subdomains. */
export interface TenantMeta {
  title: string;
  icon_url: string | null;
}

/**
 * Extract the subdomain slug from a hostname.
 * Returns null for apex, multi-level subdomains, or non-proappstore hosts.
 */
export function slugFromHostname(hostname: string): string | null {
  const h = normalizeHostname(hostname);
  if (!h.endsWith(ZONE)) return null;
  const slug = h.slice(0, -ZONE.length);
  if (slug.length === 0) return null; // apex
  if (slug.includes(".")) return null; // multi-level
  return slug;
}

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().split(":")[0]!;
}

/** Reserved subdomains dispatched via service bindings, not served from R2. */
export const RESERVED_SUBDOMAINS = new Set([
  "admin",
  "api",
  "agents",
  "mcp",
  "kb",
  "docs",
  "www",
  "console",
  "dashboard",
]);

/** Look up a route from D1. Returns null if no matching row. */
export async function resolveRoute(db: D1Database, slug: string): Promise<Route | null> {
  return db
    .prepare("SELECT slug, zone, r2_prefix, store FROM routes WHERE slug = ?1 AND zone = ?2")
    .bind(slug, PLATFORM_ZONE)
    .first<Route>();
}

/**
 * Resolve the app route for either a platform subdomain or an active BYO custom
 * domain. Custom domains still serve the app through PAS-controlled hosting,
 * which is required for same-origin platform auth cookies.
 */
export async function resolveRouteForHostname(db: D1Database, hostname: string): Promise<ResolvedRoute | null> {
  const host = normalizeHostname(hostname);
  const platformSlug = slugFromHostname(host);
  if (platformSlug) {
    const route = await resolveRoute(db, platformSlug);
    return route ? { ...route, matched: "platform" } : null;
  }

  if (host === PLATFORM_ZONE || host.endsWith(ZONE)) return null;

  const parts = host.split(".");
  const tenant = parts.length > 2 ? parts[0] : null;
  const wildcardBase = parts.length > 2 ? parts.slice(1).join(".") : null;
  const row = await db
    .prepare(
      `SELECT r.slug, r.zone, r.r2_prefix, r.store, d.kind, d.domain AS matched_domain
       FROM app_custom_domains d
       JOIN routes r ON r.slug = d.app_id AND r.zone = ?1
       WHERE d.status = 'active'
         AND ((COALESCE(d.kind, 'exact') = 'exact' AND d.domain = ?2)
           OR (COALESCE(d.kind, 'exact') = 'wildcard' AND d.domain = ?2)
           OR (COALESCE(d.kind, 'exact') = 'wildcard' AND d.domain = ?3))
       -- Deterministic, specificity-first ordering. Without the extra keys two
       -- overlapping wildcard rows (a sub-zone owned by app B vs its parent zone
       -- owned by app A) tie and LIMIT 1 picks one arbitrarily → the wrong app's
       -- r2_prefix/tenant is served nondeterministically. Prefer: exact domain,
       -- then a wildcard matching the full host (own apex) over one matching only
       -- the parent base, then the longer (more specific) base, then a stable id.
       ORDER BY CASE COALESCE(d.kind, 'exact') WHEN 'exact' THEN 0 ELSE 1 END,
         CASE WHEN d.domain = ?2 THEN 0 ELSE 1 END,
         LENGTH(d.domain) DESC,
         d.app_id
       LIMIT 1`,
    )
    .bind(PLATFORM_ZONE, host, wildcardBase)
    .first<Route & { kind?: string | null; matched_domain?: string | null }>();

  if (!row) return null;
  if (row.kind === "wildcard") {
    return { slug: row.slug, zone: row.zone, r2_prefix: row.r2_prefix, store: row.store, matched: "wildcard", tenant: row.matched_domain === host ? undefined : tenant ?? undefined, base: row.matched_domain ?? wildcardBase ?? undefined };
  }
  return { slug: row.slug, zone: row.zone, r2_prefix: row.r2_prefix, store: row.store, matched: "exact" };
}

/** Fetch listing metadata for meta tag injection. Returns null if no listing exists. */
export async function getListingMeta(db: D1Database, appId: string): Promise<ListingMeta | null> {
  return db
    .prepare("SELECT icon_url, tagline FROM app_listings WHERE app_id = ?1")
    .bind(appId)
    .first<ListingMeta>();
}

/**
 * Fetch public tenant branding from an app's registered public action. The host
 * must fail open here: metadata should improve previews, never block serving.
 */
export async function getTenantMeta(
  api: Fetcher,
  appId: string,
  tenant: string | undefined,
  fallbackFetch: typeof fetch = fetch,
): Promise<TenantMeta | null> {
  if (!tenant) return null;
  const url = `https://api.proappstore.online/v1/apps/${encodeURIComponent(appId)}/actions/get_org_by_slug`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params: { slug: tenant } }),
  };
  const readMeta = async (res: Response): Promise<TenantMeta | null> => {
    if (!res.ok) return null;
    const data = await res.json() as { rows?: Array<{ name?: unknown; logo_url?: unknown }> };
    const row = data.rows?.[0];
    const title = typeof row?.name === "string" ? row.name.trim() : "";
    if (!title) return null;
    return {
      title,
      icon_url: typeof row?.logo_url === "string" && row.logo_url.trim() ? row.logo_url.trim() : null,
    };
  };
  try {
    const meta = await readMeta(await api.fetch(new Request(url, init)));
    if (meta) return meta;
  } catch {
    // Fall through to public fetch below.
  }
  try {
    return await readMeta(await fallbackFetch(url, init));
  } catch {
    return null;
  }
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
  return (
    name === "sw.js" ||
    name === "registersw.js" ||
    name === "manifest.json" ||
    name === "manifest.webmanifest" ||
    name === "favicon.ico" ||
    name === "favicon.svg" ||
    name === "apple-touch-icon.png" ||
    /^icon-\d+x?\d*\.png$/.test(name) ||
    name === ".buildinfo.json"
  );
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
