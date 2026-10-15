import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import worker from "./index.js";

function fixture(state: { listed: number; active_revision: string | null; visibility_mode: string | null } | null, missingTable = false) {
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

const active = { listed: 1, active_revision: "rev_123", visibility_mode: "public" };

describe("dedicated marketing hostname", () => {
  it.each([null, { ...active, listed: 0 }, { ...active, visibility_mode: "private" }, { ...active, active_revision: null }])(
    "does not serve inactive, unlisted or private site (%j)", async (state) => {
      const { env, ctx, get } = fixture(state);
      const response = await worker.fetch(new Request("https://about-chess.proappstore.online/"), env, ctx);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(get).not.toHaveBeenCalled();
    },
  );

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

  it.each(["/other", "/artifact-manifest.json", "/assets/app.js.map", "/assets/%2eenv"])(
    "rejects unknown or private paths (%s)", async (path) => {
      const { env, ctx, get } = fixture(active);
      const response = await worker.fetch(new Request(`https://about-chess.proappstore.online${path}`), env, ctx);
      expect(response.status).toBe(404);
      expect(get).not.toHaveBeenCalled();
    },
  );
});
