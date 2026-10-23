import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools = new Map<string, { schema: z.ZodRawShape; annotations: Record<string, unknown>; handler: Handler }>();
const fakeServer = {
  tool: (name: string, _description: string, schema: z.ZodRawShape, annotations: Record<string, unknown>, handler: Handler) => {
    tools.set(name, { schema, annotations, handler });
  },
};
const apiFetch = vi.fn();
const kvPut = vi.fn();
const env = {
  API_BASE: "https://api.test.com",
  API: { fetch: apiFetch } as unknown as Fetcher,
  INTERNAL_TOKEN: "internal-secret",
  OAUTH_KV: { put: kvPut } as unknown as KVNamespace,
  MCP_READ_ONLY: undefined as string | undefined,
};
const { registerOidcSessionTools } = await import("./oidc-session-tools.js");
let user = { userId: "gh:2824906" as string | null, token: "session-token" as string | null };
registerOidcSessionTools(fakeServer as never, env as never, () => user);

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);
const body = (result: Result) => JSON.parse(result.content[0]!.text) as Record<string, any>;
const reply = (value: unknown, status = 200) => apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }));

beforeEach(() => {
  vi.clearAllMocks();
  user = { userId: "gh:2824906", token: "session-token" };
  env.INTERNAL_TOKEN = "internal-secret";
  env.MCP_READ_ONLY = undefined;
});

describe("OIDC session grant MCP tools (#475)", () => {
  it("registers an accurately annotated lifecycle", () => {
    expect([...tools.keys()]).toEqual(["list_oidc_session_grants", "create_oidc_session_grant", "revoke_oidc_session_grant"]);
    expect(tools.get("list_oidc_session_grants")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of ["create_oidc_session_grant", "revoke_oidc_session_grant"]) {
      expect(tools.get(name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it("refuses every tool without a session", async () => {
    user = { userId: null, token: null };
    for (const name of tools.keys()) expect((await call(name)).isError, name).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("lists through the trusted service binding with the caller session", async () => {
    reply({ grants: [] });
    expect(body(await call("list_oidc_session_grants"))).toEqual({ grants: [] });
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test.com/v1/admin/oidc-session-grants");
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer session-token", "X-Internal-Token": "internal-secret" } });
  });

  it("previews create by default and sends the exact confirmed grant", async () => {
    const input = { repository: "proappstore-online/grasskarma", user_id: "google:110736373305646082562", workflow: ".github/workflows/deploy.yml" };
    const preview = await call("create_oidc_session_grant", input);
    expect(preview.isError).toBe(true);
    expect(body(preview).preview).toContain("refs/heads/main");
    expect(apiFetch).not.toHaveBeenCalled();

    reply({ grant: { id: "g1", ...input } }, 201);
    const created = await call("create_oidc_session_grant", { ...input, confirm: true });
    expect(body(created).grant.id).toBe("g1");
    const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("requires confirmation to revoke and uses DELETE when confirmed", async () => {
    const grant_id = "64db75a4-f90c-433b-a7c4-95d86c3d0180";
    expect((await call("revoke_oidc_session_grant", { grant_id })).isError).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
    reply({ ok: true });
    expect(body(await call("revoke_oidc_session_grant", { grant_id, confirm: true }))).toEqual({ ok: true });
    expect(apiFetch.mock.calls[0]![0]).toBe(`https://api.test.com/v1/admin/oidc-session-grants/${grant_id}`);
    expect((apiFetch.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("fails closed without internal authentication and in read-only mode", async () => {
    env.INTERNAL_TOKEN = "";
    expect((await call("list_oidc_session_grants")).isError).toBe(true);
    env.INTERNAL_TOKEN = "internal-secret";
    env.MCP_READ_ONLY = "1";
    await expect(call("create_oidc_session_grant", { repository: "proappstore-online/grasskarma", user_id: "gh:1", confirm: true })).rejects.toThrow(/read-only/);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
