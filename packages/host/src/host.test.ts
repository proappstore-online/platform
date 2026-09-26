import { describe, expect, it, vi } from "vitest";
import {
  contentType,
  etagsMatch,
  getPageMeta,
  getSitemapUrls,
  getTenantMeta,
  isUpdateSensitivePath,
  matchPagePath,
  PAGE_META_TIMEOUT_MS,
  renderSitemap,
  RESERVED_SUBDOMAINS,
  type Route,
  resolveRouteForHostname,
  r2KeyFor,
  securityHeaders,
  slugFromHostname,
} from "./host.js";

const route: Route = {
  slug: "meetup",
  zone: "proappstore.online",
  r2_prefix: "apps/meetup",
  store: "pas",
};

describe("slugFromHostname", () => {
  it("extracts slug from subdomain", () => {
    expect(slugFromHostname("meetup.proappstore.online")).toBe("meetup");
    expect(slugFromHostname("chess-academy.proappstore.online")).toBe("chess-academy");
  });

  it("returns null for apex", () => {
    expect(slugFromHostname("proappstore.online")).toBeNull();
  });

  it("returns null for multi-level subdomain", () => {
    expect(slugFromHostname("a.b.proappstore.online")).toBeNull();
  });

  it("returns null for non-proappstore host", () => {
    expect(slugFromHostname("meetup.example.com")).toBeNull();
  });

  it("strips port", () => {
    expect(slugFromHostname("meetup.proappstore.online:8787")).toBe("meetup");
  });

  it("is case-insensitive", () => {
    expect(slugFromHostname("MeetUp.ProAppStore.Online")).toBe("meetup");
  });
});

describe("RESERVED_SUBDOMAINS", () => {
  it("reserves docs for KB-host dispatch", () => {
    expect(RESERVED_SUBDOMAINS.has("docs")).toBe(true);
    expect(RESERVED_SUBDOMAINS.has("kb")).toBe(true);
  });
});

describe("r2KeyFor", () => {
  it("maps root to index.html", () => {
    expect(r2KeyFor(route, "/")).toBe("apps/meetup/index.html");
    expect(r2KeyFor(route, "")).toBe("apps/meetup/index.html");
  });

  it("maps directory paths to index.html", () => {
    expect(r2KeyFor(route, "/about/")).toBe("apps/meetup/about/index.html");
  });

  it("maps file paths directly", () => {
    expect(r2KeyFor(route, "/assets/main.js")).toBe("apps/meetup/assets/main.js");
  });

  it("strips leading slashes", () => {
    expect(r2KeyFor(route, "///style.css")).toBe("apps/meetup/style.css");
  });
});

describe("resolveRouteForHostname", () => {
  it("resolves platform app subdomains through the routes table", async () => {
    const db = fakeRouteDb();

    await expect(resolveRouteForHostname(db, "meetup.proappstore.online")).resolves.toEqual({ ...route, matched: "platform" });
  });

  it("resolves active custom domains back to their app route", async () => {
    const db = fakeRouteDb();

    await expect(resolveRouteForHostname(db, "app.example.com")).resolves.toEqual({ ...route, matched: "exact" });
  });

  it("resolves a single-label tenant under an active wildcard base", async () => {
    const db = fakeRouteDb();

    await expect(resolveRouteForHostname(db, "chessideas.chessclubs.online")).resolves.toEqual({
      ...route,
      matched: "wildcard",
      tenant: "chessideas",
      base: "chessclubs.online",
    });
  });

  it("resolves an active wildcard base host back to its app route", async () => {
    const db = fakeRouteDb();

    await expect(resolveRouteForHostname(db, "chessclubs.online")).resolves.toEqual({
      ...route,
      matched: "wildcard",
      base: "chessclubs.online",
    });
  });

  it("prefers exact domains over wildcard base matches", async () => {
    const db = fakeRouteDb();

    await expect(resolveRouteForHostname(db, "club.chessclubs.online")).resolves.toEqual({ ...route, matched: "exact" });
  });

  it("does not match wildcard bases for multi-level tenant hosts", async () => {
    const db = fakeRouteDb();

    await expect(resolveRouteForHostname(db, "a.b.chessclubs.online")).resolves.toBeNull();
  });

  it("does not treat arbitrary proappstore subdomains or inactive custom domains as apps", async () => {
    const db = fakeRouteDb();

    await expect(resolveRouteForHostname(db, "missing.proappstore.online")).resolves.toBeNull();
    await expect(resolveRouteForHostname(db, "pending.example.com")).resolves.toBeNull();
  });
});

describe("getTenantMeta", () => {
  it("returns public organization branding for a tenant slug", async () => {
    const fetch = vi.fn(async (req: Request) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("https://api.proappstore.online/v1/apps/chess-academy/actions/get_org_by_slug");
      await expect(req.json()).resolves.toEqual({ params: { slug: "chess-ideas" } });
      return Response.json({ rows: [{ name: " Chess Ideas ", logo_url: " https://cdn.example/logo.png " }] });
    });
    const api = { fetch } as unknown as Fetcher;

    await expect(getTenantMeta(api, "chess-academy", "chess-ideas")).resolves.toEqual({
      title: "Chess Ideas",
      icon_url: "https://cdn.example/logo.png",
    });
  });

  it("fails open when tenant metadata is unavailable", async () => {
    const api = { fetch: vi.fn(async () => new Response("nope", { status: 500 })) } as unknown as Fetcher;
    const fallbackFetch = vi.fn(async () => new Response("nope", { status: 500 }));

    await expect(getTenantMeta(api, "chess-academy", "chess-ideas", fallbackFetch as typeof fetch)).resolves.toBeNull();
    await expect(getTenantMeta(api, "chess-academy", undefined, fallbackFetch as typeof fetch)).resolves.toBeNull();
  });

  it("falls back to public API fetch when the service binding has no metadata", async () => {
    const api = { fetch: vi.fn(async () => Response.json({ rows: [] })) } as unknown as Fetcher;
    const fallbackFetch = vi.fn(async () => Response.json({ rows: [{ name: "Chess Ideas", logo_url: null }] }));

    await expect(getTenantMeta(api, "chess-academy", "chess-ideas", fallbackFetch as typeof fetch)).resolves.toEqual({
      title: "Chess Ideas",
      icon_url: null,
    });
    expect(fallbackFetch).toHaveBeenCalledOnce();
  });
});

function fakeRouteDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("app_custom_domains")) {
                const domain = args[1];
                const wildcardBase = args[2];
                if (domain === "app.example.com" || domain === "club.chessclubs.online") {
                  return { ...route, kind: "exact", matched_domain: domain } as T;
                }
                if (domain === "chessclubs.online" || wildcardBase === "chessclubs.online") {
                  return { ...route, kind: "wildcard", matched_domain: "chessclubs.online" } as T;
                }
                return null as T | null;
              }
              const [slug, zone] = args;
              return (slug === route.slug && zone === route.zone ? route : null) as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("etagsMatch", () => {
  it("returns false for null header", () => {
    expect(etagsMatch(null, '"abc"')).toBe(false);
  });

  it("matches wildcard", () => {
    expect(etagsMatch("*", '"abc"')).toBe(true);
  });

  it("matches exact etag", () => {
    expect(etagsMatch('"abc"', '"abc"')).toBe(true);
  });

  it("matches one of multiple etags", () => {
    expect(etagsMatch('"x", "abc", "y"', '"abc"')).toBe(true);
  });

  it("rejects non-matching etag", () => {
    expect(etagsMatch('"different"', '"abc"')).toBe(false);
  });
});

describe("contentType", () => {
  it("returns correct MIME for all mapped extensions", () => {
    expect(contentType("index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("style.css")).toBe("text/css; charset=utf-8");
    expect(contentType("main.js")).toBe("application/javascript; charset=utf-8");
    expect(contentType("lib.mjs")).toBe("application/javascript; charset=utf-8");
    expect(contentType("data.json")).toBe("application/json; charset=utf-8");
    expect(contentType("icon.svg")).toBe("image/svg+xml");
    expect(contentType("logo.png")).toBe("image/png");
    expect(contentType("photo.jpg")).toBe("image/jpeg");
    expect(contentType("photo.jpeg")).toBe("image/jpeg");
    expect(contentType("anim.gif")).toBe("image/gif");
    expect(contentType("hero.webp")).toBe("image/webp");
    expect(contentType("hero.avif")).toBe("image/avif");
    expect(contentType("favicon.ico")).toBe("image/x-icon");
    expect(contentType("font.woff2")).toBe("font/woff2");
    expect(contentType("font.woff")).toBe("font/woff");
    expect(contentType("manifest.webmanifest")).toBe("application/manifest+json");
    expect(contentType("readme.txt")).toBe("text/plain; charset=utf-8");
    expect(contentType("feed.xml")).toBe("application/xml; charset=utf-8");
  });

  it("returns octet-stream for unknown extensions", () => {
    expect(contentType("file.xyz")).toBe("application/octet-stream");
    expect(contentType("noext")).toBe("application/octet-stream");
  });
});

describe("isUpdateSensitivePath", () => {
  it("marks stable PWA files as update-sensitive", () => {
    expect(isUpdateSensitivePath("/sw.js")).toBe(true);
    expect(isUpdateSensitivePath("apps/interns/registerSW.js")).toBe(true);
    expect(isUpdateSensitivePath("/manifest.json")).toBe(true);
    expect(isUpdateSensitivePath("/manifest.webmanifest")).toBe(true);
    expect(isUpdateSensitivePath("/favicon.svg")).toBe(true);
    expect(isUpdateSensitivePath("/favicon.ico")).toBe(true);
    expect(isUpdateSensitivePath("/apple-touch-icon.png")).toBe(true);
    expect(isUpdateSensitivePath("/icon-192.png")).toBe(true);
    expect(isUpdateSensitivePath("/icon-512.png")).toBe(true);
  });

  it("marks deploy metadata as update-sensitive", () => {
    expect(isUpdateSensitivePath("/.buildinfo.json")).toBe(true);
    expect(isUpdateSensitivePath("apps/interns/.buildinfo.json")).toBe(true);
  });

  it("marks app API documentation as update-sensitive", () => {
    expect(isUpdateSensitivePath("/api-docs.html")).toBe(true);
    expect(isUpdateSensitivePath("/openapi.json")).toBe(true);
    expect(isUpdateSensitivePath("/openapi.yaml")).toBe(true);
  });

  it("does not mark hashed assets as update-sensitive", () => {
    expect(isUpdateSensitivePath("/assets/index-B8lC6GEu.js")).toBe(false);
  });
});

describe("securityHeaders", () => {
  it("sets CSP, XCTO, XFO, referrer policy for HTML", () => {
    const h = securityHeaders(true);
    expect(h.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(h.get("Content-Security-Policy")).toContain("api.proappstore.online");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets short cache for HTML", () => {
    expect(securityHeaders(true).get("Cache-Control")).toContain("must-revalidate");
  });

  it("sets immutable cache for assets", () => {
    expect(securityHeaders(false).get("Cache-Control")).toContain("immutable");
  });

  it("does not set immutable cache for update-sensitive files", () => {
    expect(securityHeaders(false, true).get("Cache-Control")).toContain("must-revalidate");
    expect(securityHeaders(false, true).get("Cache-Control")).not.toContain("immutable");
  });
});

// #210: per-route link-preview meta and sitemap from declared public actions.
describe("matchPagePath", () => {
  it("returns the decoded placeholder value for a matching path, tolerating one trailing slash", () => {
    expect(matchPagePath("/p/:id", "/p/abc")).toBe("abc");
    expect(matchPagePath("/p/:id", "/p/abc/")).toBe("abc");
    expect(matchPagePath("/c/:slug/about", "/c/vacuum%20pumps/about")).toBe("vacuum pumps");
  });

  it("does not match other shapes, an empty segment, bad escapes, or an over-long value", () => {
    expect(matchPagePath("/p/:id", "/")).toBeNull();
    expect(matchPagePath("/p/:id", "/p")).toBeNull();
    expect(matchPagePath("/p/:id", "/p/abc/extra")).toBeNull();
    expect(matchPagePath("/p/:id", "/q/abc")).toBeNull();
    expect(matchPagePath("/p/:id", "/p/%E0%A4%A")).toBeNull();
    expect(matchPagePath("/p/:id", `/p/${"x".repeat(201)}`)).toBeNull();
  });
});

describe("getPageMeta", () => {
  const db = (routes: unknown[] | Error) => ({
    prepare: () => ({ bind: () => ({ all: async () => { if (routes instanceof Error) throw routes; return { results: routes }; } }) }),
  }) as unknown as D1Database;
  const productRoute = [{ path_pattern: "/p/:id", action_name: "public_product_meta", param_name: "id" }];
  const api = (handler: (req: Request) => Promise<Response>) => ({ fetch: vi.fn(handler) }) as unknown as Fetcher & { fetch: ReturnType<typeof vi.fn> };

  it("calls the matching route's action with the path value and returns trimmed, bounded fields", async () => {
    const fetcher = api(async (req) => {
      expect(req.url).toBe("https://api.proappstore.online/v1/apps/tradeport/actions/public_product_meta");
      await expect(req.json()).resolves.toEqual({ params: { id: "abc" } });
      expect(req.signal).toBeDefined();
      return Response.json({ rows: [{ title: " Rotary pump ", description: "Two stage", image_url: "https://cdn.test/p.png" }] });
    });
    await expect(getPageMeta(db(productRoute), fetcher, "tradeport", "/p/abc")).resolves.toEqual({
      title: "Rotary pump", description: "Two stage", image_url: "https://cdn.test/p.png",
    });
  });

  it("only accepts an http(s) image and keeps the other fields", async () => {
    const fetcher = api(async () => Response.json({ rows: [{ title: "T", description: null, image_url: "javascript:alert(1)" }] }));
    await expect(getPageMeta(db(productRoute), fetcher, "tradeport", "/p/abc")).resolves.toEqual({ title: "T", description: null, image_url: null });
  });

  it("fails open: no matching route, D1 error, action error, empty row, or a throwing binding all give null", async () => {
    const ok = api(async () => Response.json({ rows: [{ title: "T" }] }));
    await expect(getPageMeta(db(productRoute), ok, "tradeport", "/")).resolves.toBeNull();
    expect(ok.fetch).not.toHaveBeenCalled(); // "/" matches no route: no action call
    await expect(getPageMeta(db(new Error("no such table: app_page_meta")), ok, "tradeport", "/p/abc")).resolves.toBeNull();
    await expect(getPageMeta(db(productRoute), api(async () => Response.json({ error: "boom" }, { status: 500 })), "tradeport", "/p/abc")).resolves.toBeNull();
    await expect(getPageMeta(db(productRoute), api(async () => Response.json({ rows: [] })), "tradeport", "/p/abc")).resolves.toBeNull();
    await expect(getPageMeta(db(productRoute), api(async () => Response.json({ rows: [{ title: "  " }] })), "tradeport", "/p/abc")).resolves.toBeNull();
    await expect(getPageMeta(db(productRoute), api(async () => { throw new Error("binding down"); }), "tradeport", "/p/abc")).resolves.toBeNull();
  });

  it(`gives up on a slow action after ${PAGE_META_TIMEOUT_MS} ms`, async () => {
    const hang = api((req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason))));
    const started = Date.now();
    await expect(getPageMeta(db(productRoute), hang, "tradeport", "/p/abc")).resolves.toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(PAGE_META_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(PAGE_META_TIMEOUT_MS + 1500);
  }, 10_000);
});

describe("getSitemapUrls / renderSitemap", () => {
  it("pages by cursor (the last path) until an empty page, keeping same-origin paths only", async () => {
    const pages: Record<string, unknown[]> = {
      "": [{ path: "/p/a", updated_at: Date.UTC(2026, 8, 1) }, { path: "//evil.example/x" }, { path: "/p/b", updated_at: "2026-09-02T00:00:00Z" }],
      "/p/b": [{ path: "/p/c", updated_at: "not a date" }],
      "/p/c": [],
    };
    const cursors: string[] = [];
    const fetcher = { fetch: vi.fn(async (req: Request) => {
      const { params } = (await req.json()) as { params: { cursor: string } };
      cursors.push(params.cursor);
      return Response.json({ rows: pages[params.cursor] ?? [] });
    }) } as unknown as Fetcher;
    await expect(getSitemapUrls(fetcher, "tradeport", "public_sitemap_urls")).resolves.toEqual([
      { path: "/p/a", lastmod: "2026-09-01T00:00:00.000Z" },
      { path: "/p/b", lastmod: "2026-09-02T00:00:00.000Z" },
      { path: "/p/c", lastmod: null },
    ]);
    expect(cursors).toEqual(["", "/p/b", "/p/c"]);
  });

  it("stops when an action ignores the cursor, and returns null (never an empty sitemap) when a page fails", async () => {
    const same = { fetch: vi.fn(async () => Response.json({ rows: [{ path: "/only" }] })) } as unknown as Fetcher & { fetch: ReturnType<typeof vi.fn> };
    await expect(getSitemapUrls(same, "a", "s")).resolves.toEqual([{ path: "/only", lastmod: null }]);
    expect(same.fetch).toHaveBeenCalledTimes(2);
    const broken = { fetch: vi.fn(async () => new Response("x", { status: 500 })) } as unknown as Fetcher;
    await expect(getSitemapUrls(broken, "a", "s")).resolves.toBeNull();
  });

  it("renders a sitemaps.org urlset with escaped locations", () => {
    const out = renderSitemap("https://tradeport.proappstore.online", [{ path: "/p/a&b<c>", lastmod: "2026-09-01T00:00:00.000Z" }, { path: "/", lastmod: null }]);
    expect(out).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(out).toContain("<url><loc>https://tradeport.proappstore.online/p/a&amp;b&lt;c&gt;</loc><lastmod>2026-09-01T00:00:00.000Z</lastmod></url>");
    expect(out).toContain("<url><loc>https://tradeport.proappstore.online/</loc></url>");
  });
});
