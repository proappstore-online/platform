import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { registerPlatformTools } from "./platform-tools.js";
import { TOOL_CACHE_TTL_MS } from "./tool-loader.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/** Capture the app_info handler, with the host binding answering `res`. */
function appInfo(res: Response): Handler {
  const handlers = new Map<string, Handler>();
  const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) } as unknown as McpServer;
  registerPlatformTools(server, { GITHUB_ORG: "proappstore-online", HOST: { fetch: vi.fn(async () => res) } } as unknown as Env);
  return handlers.get("app_info")!;
}

describe("app_info on a private app (#259 review)", () => {
  it("reports a visibility refusal as live-and-private, not down", async () => {
    const out = await appInfo(new Response("Forbidden", { status: 403, headers: { "X-PAS-Visibility": "private" } }))({ app_id: "diary" });
    expect(out.content[0]!.text).toContain("Status: Live (private — sign-in required, 403)");
  });

  it("still reports any other failure as down", async () => {
    const out = await appInfo(new Response("nope", { status: 403 }))({ app_id: "diary" });
    expect(out.content[0]!.text).toContain("Status: Down (403)");
  });
});

describe("MCP flip bound (#259 review)", () => {
  it("the shared tool cache lists a newly private app's tools for at most 10 s", () => {
    expect(TOOL_CACHE_TTL_MS).toBeLessThanOrEqual(10_000);
  });
});
