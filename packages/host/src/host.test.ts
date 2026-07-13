import { describe, expect, it } from "vitest";
import {
  contentType,
  etagsMatch,
  isUpdateSensitivePath,
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
    expect(isUpdateSensitivePath("/manifest.webmanifest")).toBe(true);
  });

  it("marks deploy metadata as update-sensitive", () => {
    expect(isUpdateSensitivePath("/.buildinfo.json")).toBe(true);
    expect(isUpdateSensitivePath("apps/interns/.buildinfo.json")).toBe(true);
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
