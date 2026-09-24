import { mintSession } from "@proappstore/build-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import type { Env } from "./env.js";

/**
 * #26: Turnstile on browser-driven publishes. The provisioning behind the route
 * is mocked — these tests pin the gate in front of it.
 */
vi.mock("./provision-guard.js", async (orig) => ({ ...(await orig<typeof import("./provision-guard.js")>()), guardProvisionRequest: vi.fn(async () => ({ ok: true })) }));
vi.mock("./publish.js", async (orig) => ({ ...(await orig<typeof import("./publish.js")>()), handlePublish: vi.fn(async () => ({ success: true, published: true })) }));

const KEY = "test-signing-key";
const TS = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };
const ctx = {} as ExecutionContext;
const env = (over: Record<string, unknown> = {}): Env => ({ SESSION_SIGNING_KEY: KEY, INTERNAL_TOKEN: "internal-secret", ...over }) as unknown as Env;
const publish = async (headers: Record<string, string>, body: Record<string, unknown>, e: Env) =>
  worker.fetch(new Request("https://admin.proappstore.online/api/publish-app", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), e, ctx);

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/publish-app bot check (#26)", () => {
  it("a browser publish (Origin header) must carry a token when Turnstile is configured; the verdict is checked with the publish action", async () => {
    const token = await mintSession({ uid: "gh:1", login: "serge-ivo", roles: ["user"] }, KEY);
    const browser = { Authorization: `Bearer ${token}`, Origin: "https://console.proappstore.online", "CF-Connecting-IP": "203.0.113.9" };
    const noFetch = vi.fn();
    vi.stubGlobal("fetch", noFetch);
    const missing = await publish(browser, { id: "myapp" }, env(TS));
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "bot check required" });
    expect(noFetch).not.toHaveBeenCalled();

    const seen: URLSearchParams[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      seen.push(new URLSearchParams(String(init?.body)));
      return Response.json({ success: true, action: "publish" });
    }));
    const ok = await publish(browser, { id: "myapp", turnstileToken: "widget-token" }, env(TS));
    expect(ok.status).toBe(200);
    expect(Object.fromEntries(seen[0]!)).toEqual({ secret: "secret-key", response: "widget-token", remoteip: "203.0.113.9" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, action: "register" })));
    const wrongForm = await publish({ ...browser, "CF-Turnstile-Response": "signup-token" }, { id: "myapp" }, env(TS));
    expect(wrongForm.status).toBe(403);
    expect(await wrongForm.json()).toEqual({ error: "bot check failed" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    expect((await publish(browser, { id: "myapp", turnstileToken: "t" }, env(TS))).status).toBe(503);
  });

  it("a CLI publish (no Origin) and an internal-token publish never need a token; an unconfigured Worker is inert", async () => {
    const noFetch = vi.fn();
    vi.stubGlobal("fetch", noFetch);
    const token = await mintSession({ uid: "gh:1", login: "serge-ivo", roles: ["user"] }, KEY);
    expect((await publish({ Authorization: `Bearer ${token}` }, { id: "myapp" }, env(TS))).status).toBe(200);
    expect((await publish({ "X-Internal-Token": "internal-secret", "X-PAS-Login": "serge-ivo", Origin: "https://agents.proappstore.online" }, { id: "myapp" }, env(TS))).status).toBe(200);
    expect((await publish({ Authorization: `Bearer ${token}`, Origin: "https://console.proappstore.online" }, { id: "myapp" }, env())).status).toBe(200);
    expect((await publish({ Authorization: `Bearer ${token}`, Origin: "https://console.proappstore.online" }, { id: "myapp" }, env({ TURNSTILE_SECRET_KEY: "secret-key" }))).status).toBe(200);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("GET /api/turnstile publishes the site key only when enforcement is on, never the secret", async () => {
    const get = (e: Env) => worker.fetch(new Request("https://admin.proappstore.online/api/turnstile"), e, ctx);
    expect(await (await get(env())).json()).toEqual({ siteKey: null, action: "publish" });
    const on = await get(env(TS));
    expect(await on.json()).toEqual({ siteKey: "site-key", action: "publish" });
    expect(on.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});
