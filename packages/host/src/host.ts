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

/** Per-route link-preview metadata from an app's declared `page_meta` action (#210). */
export interface PageMeta {
  title: string | null;
  description: string | null;
  image_url: string | null;
}

export interface SitemapUrl {
  path: string;
  lastmod: string | null;
}

/** Page meta sits on the HTML hot path: a slow app action must not hold the page. */
export const PAGE_META_TIMEOUT_MS = 1500;
/** Pages fetched per sitemap build (each at most the public LIMIT of 500 rows). */
export const SITEMAP_MAX_PAGES = 20;

/** The value of the pattern's one `:param` segment if `pathname` matches it, else null. */
export function matchPagePath(pattern: string, pathname: string): string | null {
  const want = pattern.split("/");
  const got = (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname).split("/");
  if (want.length !== got.length) return null;
  let value: string | null = null;
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(":")) {
      try {
        value = decodeURIComponent(got[i]!);
      } catch {
        return null;
      }
      if (!value || value.length > 200) return null;
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return value;
}

/** POST a public action over the API binding with a timeout; its rows, or null on any failure. */
async function callPublicAction(api: Fetcher, appId: string, action: string, params: Record<string, unknown>): Promise<Record<string, unknown>[] | null> {
  try {
    const res = await api.fetch(new Request(
      `https://api.proappstore.online/v1/apps/${encodeURIComponent(appId)}/actions/${encodeURIComponent(action)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params }),
        signal: AbortSignal.timeout(PAGE_META_TIMEOUT_MS),
      },
    ));
    if (!res.ok) return null;
    const data = await res.json() as { rows?: unknown };
    return Array.isArray(data.rows) ? data.rows as Record<string, unknown>[] : null;
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const httpUrl = (v: unknown): string | null => {
  const s = text(v, 2000);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

/**
 * Link-preview metadata for this path from the app's first matching `page_meta`
 * route. Fails open like getTenantMeta: any error, timeout or empty row → null,
 * and the page is served with app-level meta.
 */
export async function getPageMeta(db: D1Database, api: Fetcher, appId: string, pathname: string): Promise<PageMeta | null> {
  let routes: { path_pattern: string; action_name: string; param_name: string }[];
  try {
    routes = (await db
      .prepare("SELECT path_pattern, action_name, param_name FROM app_page_meta WHERE app_id = ?1 ORDER BY position")
      .bind(appId)
      .all<{ path_pattern: string; action_name: string; param_name: string }>()).results ?? [];
  } catch {
    return null;
  }
  for (const route of routes) {
    const value = matchPagePath(route.path_pattern, pathname);
    if (value === null) continue;
    const row = (await callPublicAction(api, appId, route.action_name, { [route.param_name]: value }))?.[0];
    if (!row) return null;
    const meta = { title: text(row.title, 200), description: text(row.description, 500), image_url: httpUrl(row.image_url) };
    return meta.title || meta.description || meta.image_url ? meta : null;
  }
  return null;
}

/** The app's declared sitemap action, or null when it declares none (or on error). */
export async function getSitemapAction(db: D1Database, appId: string): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT action_name FROM app_sitemap WHERE app_id = ?1").bind(appId).first<{ action_name: string }>();
    return row?.action_name ?? null;
  } catch {
    return null;
  }
}

/**
 * Every sitemap URL from the app's action, keyset-paged by `cursor` (the last
 * row's path) until an empty page, a cursor that does not advance, or
 * SITEMAP_MAX_PAGES. Null when any page fails, so a broken action is never
 * published (and cached) as an empty sitemap.
 */
export async function getSitemapUrls(api: Fetcher, appId: string, action: string): Promise<SitemapUrl[] | null> {
  const urls = new Map<string, SitemapUrl>();
  let cursor = "";
  for (let page = 0; page < SITEMAP_MAX_PAGES; page++) {
    const rows = await callPublicAction(api, appId, action, { cursor });
    if (!rows) return null;
    if (rows.length === 0) break;
    let last = cursor;
    for (const row of rows) {
      const path = text(row.path, 2000);
      // Same-origin paths only: "//host" would be protocol-relative.
      if (!path || !path.startsWith("/") || path.startsWith("//")) continue;
      last = path;
      const at = typeof row.updated_at === "number" || typeof row.updated_at === "string" ? new Date(row.updated_at) : null;
      urls.set(path, { path, lastmod: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null });
    }
    if (last === cursor) break;
    cursor = last;
  }
  return [...urls.values()];
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A sitemaps.org urlset for this origin. */
export function renderSitemap(origin: string, urls: SitemapUrl[]): string {
  const entries = urls.map((u) =>
    `  <url><loc>${xml(origin + u.path)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}${entries.length ? "\n" : ""}</urlset>\n`;
}

/**
 * Paths never served from an app's R2 prefix, whatever was uploaded.
 *
 * Source maps de-minify an app back to its original source. PAS explicitly allows
 * **proprietary** source on Pro (it is a headline paid feature), and the serving
 * path maps any request 1:1 onto the app's prefix with no filtering — so a single
 * `build.sourcemap: true` in an app's Vite config would publish that app's source
 * at `/assets/index-abc.js.map` with nothing to stop it.
 *
 * No app sets `sourcemap` today and Vite's default is off, so this closes a latent
 * hole rather than an active leak. It is also a precondition for read-time
 * symbolication (ADR-008), which needs maps uploaded to a *private* prefix —
 * without this block, "upload the maps" and "keep the source private" are
 * contradictory.
 *
 * FAS requires MIT so public maps would be harmless there; blocking by default is
 * the right side to err on for PAS. An open-source Pro app that *wants* public
 * maps would need a per-app opt-in, which does not exist yet.
 */
export function isBlockedAssetPath(pathname: string): boolean {
  return /\.map$/i.test(pathname.split("?")[0] ?? "");
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
    name === "api-docs.html" ||
    name === "openapi.json" ||
    name === "openapi.yaml" ||
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
      // SECURITY: do NOT allow the `*.proappstore.online` wildcard here — it let
      // any published app frame any other app (cross-app clickjacking). Allow
      // only self + first-party surfaces that legitimately embed app previews.
      "frame-ancestors 'self' https://proappstore.online https://console.proappstore.online https://dashboard.proappstore.online https://admin.proappstore.online https://agents.proappstore.online",
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
