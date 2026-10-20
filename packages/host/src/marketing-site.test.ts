import { openPermissionsPolicy } from "./capabilities.js";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import worker from "./index.js";

function fixture(state: { active_revision: string | null } | null, missingTable = false) {
  const get = vi.fn(async (_key: string) => ({
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<h1>Market</h1>")); controller.close(); } }),
    httpEtag: '"abc"', size: 15,
  }));
  const first = vi.fn(async () => {
    if (missingTable) throw new Error("no such table: app_marketing_sites");
    return state;
  });
  const prepare = vi.fn((_sql: string) => ({ bind: (_id: string) => ({ first }) }));
  const env = { APPS: { get }, DB: { prepare } } as unknown as Env;
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return { env, ctx, get, prepare };
}

const active = { active_revision: "rev_123" };

describe("dedicated marketing hostname", () => {
  it.each([null, { active_revision: null }, { active_revision: "../escape" }])(
    "does not serve an app with no valid active revision (%j)", async (state) => {
      const { env, ctx, get } = fixture(state);
      const response = await worker.fetch(new Request("https://about-chess.proappstore.online/"), env, ctx);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("#409: neither visibility nor the storefront listing gates the site — only the active revision", async () => {
    const { env, ctx, prepare } = fixture(active);
    const res = await worker.fetch(new Request("https://about-chess.proappstore.online/"), env, ctx);
    expect(res.status).toBe(200);
    const sql = String(prepare.mock.calls[0]![0]);
    expect(sql).toContain("app_marketing_sites");
    expect(sql).not.toMatch(/app_visibility|app_storefront_publication/);
  });

  it("fails closed before the migration exists", async () => {
    const { env, ctx, get } = fixture(active, true);
    const response = await worker.fetch(new Request("https://about-chess.proappstore.online/"), env, ctx);
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("serves only the active immutable revision with SEO assets and HEAD support", async () => {
    const { env, ctx, get } = fixture(active);
    const root = await worker.fetch(new Request("https://about-chess.proappstore.online/"), env, ctx);
    expect(root.status).toBe(200);
    expect(root.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(get).toHaveBeenCalledWith("marketing/chess/revisions/rev_123/index.html");
    expect(await root.text()).toBe("<h1>Market</h1>");

    const head = await worker.fetch(new Request("https://about-chess.proappstore.online/assets/hero.png", { method: "HEAD" }), env, ctx);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(get).toHaveBeenCalledWith("marketing/chess/revisions/rev_123/assets/hero.png");
  });

  it("#399: sends a static-site policy, the serving revision and a working ETag", async () => {
    const { env, ctx } = fixture(active);
    const res = await worker.fetch(new Request("https://about-chess.proappstore.online/"), env, ctx);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-PAS-Marketing-Revision")).toBe("rev_123");
    // #436: default-open, like the app: every feature allowed on the site's own origin.
    expect(res.headers.get("Permissions-Policy")).toBe(openPermissionsPolicy("self"));
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(res.headers.get("ETag")).toBe('"abc"');
    const cached = await worker.fetch(new Request("https://about-chess.proappstore.online/", { headers: { "If-None-Match": '"abc"' } }), env, ctx);
    expect(cached.status).toBe(304);
  });

  it("#399: looks up and reads only the hostname's own app", async () => {
    const { env, ctx, get } = fixture(active);
    await worker.fetch(new Request("https://about-rival.proappstore.online/robots.txt"), env, ctx);
    expect(get).toHaveBeenCalledWith("marketing/rival/revisions/rev_123/robots.txt");
    expect(get.mock.calls.every(([key]) => key.startsWith("marketing/rival/"))).toBe(true);
  });

  it("#408: maps directory pages to their index.html and serves root static files, as Astro builds them", async () => {
    const { env, ctx, get } = fixture(active);
    for (const [path, key] of [
      ["/privacy/", "privacy/index.html"],
      ["/privacy", "privacy/index.html"],
      ["/legal/terms/", "legal/terms/index.html"],
      ["/icon-192.png", "icon-192.png"],
      ["/favicon.ico", "favicon.ico"],
      ["/_astro/Layout.CxYGxjFr.css", "_astro/Layout.CxYGxjFr.css"],
    ]) {
      const res = await worker.fetch(new Request(`https://about-chess.proappstore.online${path}`), env, ctx);
      expect(res.status, path).toBe(200);
      expect(get, path).toHaveBeenLastCalledWith(`marketing/chess/revisions/rev_123/${key}`);
    }
  });

  it("returns an uncached 503 when R2 is unavailable", async () => {
    const { env, ctx, get } = fixture(active);
    get.mockRejectedValueOnce(new Error("R2 unavailable"));
    const response = await worker.fetch(new Request("https://about-chess.proappstore.online/"), env, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it.each(["/artifact-manifest.json", "/assets/app.js.map", "/assets/%2eenv", "/assets/..%2f..%2frival/x.png", "/_astro/.hidden.css", "/assets//x.png", "/.well-known/security.txt", "/privacy.html", "/app.js", "/sub/page.htm"])(
    "rejects unknown or private paths (%s)", async (path) => {
      const { env, ctx, get } = fixture(active);
      const response = await worker.fetch(new Request(`https://about-chess.proappstore.online${path}`), env, ctx);
      expect(response.status).toBe(404);
      expect(get).not.toHaveBeenCalled();
    },
  );
});
