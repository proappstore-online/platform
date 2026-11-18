import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { registerPlatformTools } from "./platform-tools.js";
import { TOOL_CACHE_TTL_MS } from "./tool-loader.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/** Capture the app_info handler, with the host binding answering `res`. */
function appInfo(res: Response, api = vi.fn(), token: string | null = null): Handler {
  const handlers = new Map<string, Handler>();
  const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) } as unknown as McpServer;
  registerPlatformTools(server, {
    GITHUB_ORG: "proappstore-online", HOST: { fetch: vi.fn(async () => res) },
    API: { fetch: api }, API_BASE: "https://api.proappstore.online",
  } as unknown as Env, () => token);
  return handlers.get("app_info")!;
}

describe("app_info on a private app (#259 review)", () => {
  it("reports a visibility refusal as live-and-private, not down", async () => {
    const out = await appInfo(new Response("Forbidden", { status: 403, headers: { "X-PAS-Visibility": "private" } }))({ app_id: "diary" });
    expect(out.content[0]!.text).toContain("Status: Live (private — sign-in required, 403)");
    expect(out.content[0]!.text).toContain("Listing: none (private app)");
  });

  it("still reports any other failure as down", async () => {
    const out = await appInfo(new Response("nope", { status: 403 }))({ app_id: "diary" });
    expect(out.content[0]!.text).toContain("Status: Down (403)");
  });
});

describe("app_info storefront publication", () => {
  const url = "https://proappstore.online/apps/hiring/";

  it("does not confuse a healthy deployed route with a published listing", async () => {
    const api = vi.fn(async () => Response.json({ items: [{ id: "hiring", links: { storePage: null } }] }));
    const out = await appInfo(new Response(), api, "session")({ app_id: "hiring" });
    expect(out.content[0]!.text).toContain("Status: Live (200)");
    expect(out.content[0]!.text).toContain("Listing: none (not published to the storefront)");
    expect(out.content[0]!.text).not.toContain(url);
    const [request, options] = api.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(request).searchParams.get("q")).toBe("https://hiring.proappstore.online");
    expect(options.headers).toMatchObject({ Authorization: "Bearer session" });
  });

  it("shows a listing only when the directory confirms that exact app", async () => {
    const api = vi.fn(async () => Response.json({ items: [{ id: "hiring", links: { storePage: url } }] }));
    const out = await appInfo(new Response(), api, "session")({ app_id: "hiring" });
    expect(out.content[0]!.text).toContain(`Listing: ${url}`);
  });

  it("preserves a published app's canonical storefront slug", async () => {
    const api = vi.fn(async () => Response.json({ items: [{ id: "loopride", links: { storePage: "https://proappstore.online/apps/rideshare/" } }] }));
    const out = await appInfo(new Response(), api, "session")({ app_id: "loopride" });
    expect(out.content[0]!.text).toContain("Listing: https://proappstore.online/apps/rideshare/");
  });

  it.each([
    { items: [] },
    { items: [{ id: "another-app", links: { storePage: url } }] },
    { items: [{ id: "hiring" }] },
    { items: [{ id: "hiring", links: { storePage: "https://unexpected.example/" } }] },
  ])("does not infer publication from inaccessible or incomplete evidence: %j", async (data) => {
    const out = await appInfo(new Response(), vi.fn(async () => Response.json(data)), "session")({ app_id: "hiring" });
    expect(out.content[0]!.text).toContain("Listing: unknown (publication not verified)");
    expect(out.content[0]!.text).not.toContain(url);
  });

  it("preserves route diagnostics when the publication lookup fails", async () => {
    for (const api of [vi.fn(async () => new Response("unavailable", { status: 503 })), vi.fn(async () => { throw new Error("offline"); })]) {
      const out = await appInfo(new Response(), api, "session")({ app_id: "hiring" });
      expect(out.content[0]!.text).toContain("Status: Live (200)");
      expect(out.content[0]!.text).toContain("Listing: unknown (publication not verified)");
    }
  });

  it("does not query the directory without a connection or for a private route", async () => {
    const api = vi.fn();
    const out = await appInfo(new Response(), api)({ app_id: "hiring" });
    expect(out.content[0]!.text).toContain("Listing: unknown (publication not verified)");
    await appInfo(new Response(null, { status: 403, headers: { "X-PAS-Visibility": "private" } }), api, "session")({ app_id: "hiring" });
    expect(api).not.toHaveBeenCalled();
  });
});

describe("MCP flip bound (#259 review)", () => {
  it("the shared tool cache lists a newly private app's tools for at most 10 s", () => {
    expect(TOOL_CACHE_TTL_MS).toBeLessThanOrEqual(10_000);
  });
});
