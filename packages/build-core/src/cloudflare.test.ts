import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pagesProjectName,
  ensurePagesProject,
  ensureDnsCname,
  ensureCustomDomain,
  ensureAnalytics,
  type CfConfig,
} from "./cloudflare.ts";

const CFG: CfConfig = { token: "tok", accountId: "acct", zoneId: "zone", domainBase: "proappstore.online" };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = {} } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("pagesProjectName", () => {
  it("prefixes the app id", () => {
    expect(pagesProjectName("widget")).toBe("proappstore-widget");
  });
});

describe("ensurePagesProject (POST-first, idempotent)", () => {
  it("creates → ok", async () => {
    let seen = "";
    mockFetch((url, init) => { seen = `${init?.method} ${url}`; return { body: { success: true } }; });
    const s = await ensurePagesProject(CFG, "widget");
    expect(s).toEqual({ name: "CF Pages project", status: "ok", detail: "proappstore-widget" });
    expect(seen).toBe("POST https://api.cloudflare.com/client/v4/accounts/acct/pages/projects");
  });

  it("already exists → skip (not fail)", async () => {
    mockFetch(() => ({ body: { success: false, errors: [{ message: "A project with this name already exists" }] } }));
    expect((await ensurePagesProject(CFG, "widget")).status).toBe("skip");
  });

  it("real error → fail", async () => {
    mockFetch(() => ({ body: { success: false, errors: [{ message: "quota exceeded" }] } }));
    const s = await ensurePagesProject(CFG, "widget");
    expect(s.status).toBe("fail");
    expect(s.detail).toBe("quota exceeded");
  });
});

describe("ensureDnsCname", () => {
  it("creates a proxied CNAME → ok", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((url, init) => { if (init?.method === "POST") body = JSON.parse(init.body as string); return { body: { success: true } }; });
    const s = await ensureDnsCname(CFG, "widget");
    expect(s.status).toBe("ok");
    expect(body).toMatchObject({ type: "CNAME", name: "widget", content: "proappstore-widget.pages.dev", proxied: true });
  });

  it("already exists by code 81057 → skip", async () => {
    mockFetch(() => ({ body: { success: false, errors: [{ message: "x", code: 81057 }] } }));
    expect((await ensureDnsCname(CFG, "widget")).status).toBe("skip");
  });
});

describe("ensureCustomDomain", () => {
  it("attaches host to the project → ok", async () => {
    let seen = "";
    mockFetch((url, init) => { seen = `${init?.method} ${url}`; return { body: { success: true } }; });
    const s = await ensureCustomDomain(CFG, "widget");
    expect(s.status).toBe("ok");
    expect(s.detail).toBe("widget.proappstore.online");
    expect(seen).toContain("/pages/projects/proappstore-widget/domains");
  });
});

describe("ensureAnalytics (non-fatal)", () => {
  it("mints a RUM site when absent → ok", async () => {
    mockFetch((url) => (url.includes("/list") ? { body: { success: true, result: [] } } : { body: { success: true } }));
    expect((await ensureAnalytics(CFG, "widget")).status).toBe("ok");
  });

  it("downgrades a failure to skip (never blocks a deploy)", async () => {
    mockFetch((url) => (url.includes("/list") ? { body: { success: true, result: [] } } : { body: { success: false, errors: [{ message: "boom" }] } }));
    expect((await ensureAnalytics(CFG, "widget")).status).toBe("skip");
  });
});
