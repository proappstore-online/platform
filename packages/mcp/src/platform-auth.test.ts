import { describe, expect, it, vi } from "vitest";
import { registerPlatformTools } from "./platform-tools.js";

function setup(token: string | null) {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean }>>();
  const schemas = new Map<string, Record<string, unknown>>();
  const server = { tool(name: string, _description: string, schema: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }>) {
    handlers.set(name, handler); schemas.set(name, schema);
  } };
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ apps: [], history: [], runs: [] }));
  registerPlatformTools(server as never, { API: { fetch }, API_BASE: "https://api.test" } as never, () => token);
  return { handlers, schemas, fetch };
}

describe("connection-authenticated platform tools", () => {
  it.each(["list_apps", "schema_status", "list_scheduled_runs"])("%s never takes credentials from its arguments", async (name) => {
    const { handlers, schemas, fetch } = setup("connection-session");
    expect(schemas.get(name)).not.toHaveProperty("token");
    await handlers.get(name)!({ app_id: "example", token: "other-account-token" });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("Authorization")).toBe("Bearer connection-session");
  });

  it.each(["list_apps", "schema_status", "list_scheduled_runs"])("%s fails explicitly without a connection", async (name) => {
    const { handlers, fetch } = setup(null);
    expect((await handlers.get(name)!({ app_id: "example" })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
