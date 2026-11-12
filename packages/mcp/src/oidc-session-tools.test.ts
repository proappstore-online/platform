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
    expect([...tools.keys()].slice(0, 3)).toEqual(["list_oidc_session_grants", "create_oidc_session_grant", "revoke_oidc_session_grant"]);
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

const principal_id = "tp_64db75a4-f90c-433b-a7c4-95d86c3d0180";
const grant_id = "64db75a4-f90c-433b-a7c4-95d86c3d0180";
const managedGrant = () => ({ principal_id, repository: "proappstore-online/leads", workflow: ".github/workflows/deploy.yml", expires_at: Date.now() + 86400000 });
const principalPath = `/v1/admin/test-principals/${principal_id}`;
const cases = [
  { name: "list_test_principals", args: { status: "active", limit: 2, cursor: "opaque+/=" }, method: "GET", path: "/v1/admin/test-principals?status=active&limit=2&cursor=opaque%2B%2F%3D" },
  { name: "read_test_principal", args: { principal_id }, method: "GET", path: principalPath },
  { name: "create_test_principal", args: { slug: "leads-e2e", description: "Isolated E2E", reason: "Approved test setup" }, method: "POST", path: "/v1/admin/test-principals", requestBody: { slug: "leads-e2e", description: "Isolated E2E", reason: "Approved test setup" } },
  { name: "update_test_principal", args: { principal_id, description: null, reason: "Clear metadata" }, method: "PATCH", path: principalPath, requestBody: { description: null, reason: "Clear metadata" } },
  { name: "disable_test_principal", args: { principal_id, reason: "End run" }, method: "POST", path: `${principalPath}/disable`, requestBody: { reason: "End run" } },
  { name: "enable_test_principal", args: { principal_id, reason: "Resume" }, method: "POST", path: `${principalPath}/enable`, requestBody: { reason: "Resume" } },
  { name: "list_principal_grants", args: { principal_id, limit: 100 }, method: "GET", path: `/v1/admin/oidc-session-grants?principal_id=${principal_id}&limit=100` },
  { name: "read_oidc_session_grant", args: { grant_id }, method: "GET", path: `/v1/admin/oidc-session-grants/${grant_id}` },
  { name: "revoke_principal_grant", args: { grant_id, reason: "Rotate" }, method: "DELETE", path: `/v1/admin/oidc-session-grants/${grant_id}`, requestBody: { reason: "Rotate" } },
  { name: "list_test_principal_events", args: { principal_id, grant_id, limit: 1 }, method: "GET", path: `/v1/admin/test-principal-events?principal_id=${principal_id}&grant_id=${grant_id}&limit=1` },
];

describe("managed principal MCP lifecycle (#577)", () => {
  it("registers all twelve additions with correct annotations", () => {
    expect(tools.size).toBe(15);
    for (const c of cases) {
      expect(tools.get(c.name)!.annotations).toMatchObject({ readOnlyHint: c.method === "GET", destructiveHint: c.method !== "GET" });
    }
    expect(tools.get("create_principal_grant")!.annotations.destructiveHint).toBe(true);
    expect(tools.get("preview_principal_grant")!.annotations.readOnlyHint).toBe(true);
  });

  for (const c of cases) {
    it(`${c.name} forwards method, path, body, credentials and response`, async () => {
      const response = { ok: true, principal: { id: principal_id }, next_cursor: "next-page" };
      reply(response);
      const args = { ...c.args, ...(c.method === "GET" ? {} : { confirm: true }) };
      expect(body(await call(c.name, args))).toEqual(response);
      expect(apiFetch).toHaveBeenCalledTimes(1);
      const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://api.test.com${c.path}`);
      expect(init).toMatchObject({ method: c.method, headers: { Authorization: "Bearer session-token", "X-Internal-Token": "internal-secret" } });
      if (c.requestBody) expect(JSON.parse(String(init.body))).toEqual(c.requestBody);
      else expect(init.body).toBeUndefined();
    });

    it(`${c.name} propagates backend admin denial without promoting caller`, async () => {
      user = { userId: "gh:2", token: "ordinary-user-session" };
      reply({ error: "requires platform admin" }, 403);
      const result = await call(c.name, { ...c.args, ...(c.method === "GET" ? {} : { confirm: true }) });
      expect(result.isError).toBe(true);
      expect(body(result).error).toContain("403");
      expect((apiFetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer ordinary-user-session" });
    });

    if (c.method !== "GET") {
      it(`${c.name} previews by default; dry_run overrides confirmation; read-only blocks apply`, async () => {
        expect((await call(c.name, c.args)).isError).toBe(true);
        env.MCP_READ_ONLY = "1";
        const preview = await call(c.name, { ...c.args, confirm: true, dry_run: true });
        expect(preview.isError).toBeUndefined();
        expect(body(preview).request.path).toBe(c.path);
        expect(apiFetch).not.toHaveBeenCalled();
        await expect(call(c.name, { ...c.args, confirm: true })).rejects.toThrow(/read-only/);
      });
    }
  }

  it("previews the exact normalized grant locally and applies all scoped fields unchanged", async () => {
    const input = { ...managedGrant(), environment: "production", session_ttl_seconds: 600, scope: "user", label: "Leads E2E", reason: "Approved narrow grant" };
    const preview = body(await call("preview_principal_grant", input));
    expect(preview.request).toEqual({ method: "POST", path: "/v1/admin/oidc-session-grants", body: { ...input, ref: "refs/heads/main" } });
    expect(apiFetch).not.toHaveBeenCalled();
    expect((await call("create_principal_grant", input)).isError).toBe(true);
    expect((await call("create_principal_grant", { ...input, confirm: true, dry_run: true })).isError).toBeUndefined();
    expect(apiFetch).not.toHaveBeenCalled();
    reply({ grant: { id: grant_id } }, 201);
    expect(body(await call("create_principal_grant", { ...input, confirm: true })).grant.id).toBe(grant_id);
    expect(JSON.parse(String(apiFetch.mock.calls[0]![1].body))).toEqual(preview.request.body);
    const audits = kvPut.mock.calls.map(([, value]) => String(value)).join("\n");
    expect(audits).toContain("dry_run");
    expect(audits).toContain("invoked");
    expect(audits).not.toMatch(/internal-secret|session-token/);
  });

  it("defaults to user and one hour, never a human identity or creator scope", async () => {
    const preview = body(await call("preview_principal_grant", managedGrant()));
    expect(preview.request.body).toMatchObject({ principal_id, scope: "user", session_ttl_seconds: 3600, ref: "refs/heads/main" });
    expect(preview.request.body.user_id).toBeUndefined();
    expect((await call("preview_principal_grant", { ...managedGrant(), scope: "creator" })).isError).toBeUndefined();
  });

  const badGrantFields = [
    { principal_id: grant_id }, { principal_id: "tp_bad" }, { user_id: "gh:1" },
    { workflow: undefined }, { workflow: "deploy.yml" }, { expires_at: undefined },
    { expires_at: 1 }, { expires_at: "2030-01-01T00:00:00Z" },
    { session_ttl_seconds: 59 }, { session_ttl_seconds: 14401 }, { session_ttl_seconds: 60.5 },
    { scope: "admin" }, { scope: ["user"] }, { environment: "" }, { environment: "has space" },
    { environment: "x".repeat(61) }, { ref: "main" }, { repository: "other-org/app" },
    { reason: "x".repeat(241) }, { label: "x".repeat(121) },
  ];
  for (const fields of badGrantFields) {
    it(`rejects invalid scoped fields in preview and apply: ${JSON.stringify(fields)}`, async () => {
      for (const name of ["create_principal_grant", "preview_principal_grant"]) {
        const args = { ...managedGrant(), ...fields, ...(name === "create_principal_grant" ? { confirm: true } : {}) };
        expect((await call(name, args)).isError).toBe(true);
      }
      expect(apiFetch).not.toHaveBeenCalled();
    });
  }
  for (const [name, args] of [
    ["create_test_principal", { slug: "UPPER" }],
    ["create_test_principal", { slug: "ab" }],
    ["create_test_principal", { slug: "-bad" }],
    ["create_test_principal", { slug: "x".repeat(41) }],
    ["create_test_principal", { slug: "valid", description: "x".repeat(241) }],
    ["update_test_principal", { principal_id, description: "x".repeat(241) }],
    ["update_test_principal", { principal_id, slug: "replacement" }],
    ["list_test_principals", { limit: 101 }],
    ["list_test_principals", { status: "deleted" }],
    ["read_test_principal", { principal_id: grant_id }],
  ] as const) {
    it(`rejects invalid lifecycle input: ${name} ${JSON.stringify(args).slice(0, 70)}`, async () => {
      expect((await call(name, args)).isError).toBe(true);
      expect(apiFetch).not.toHaveBeenCalled();
    });
  }

  it("handles upstream failures without exposing request credentials", async () => {
    apiFetch.mockRejectedValueOnce(new Error("internal-secret session-token"));
    const result = await call("list_test_principals");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toMatch(/internal-secret|session-token/);
    apiFetch.mockResolvedValueOnce(new Response("not JSON"));
    expect((await call("list_test_principals")).isError).toBe(true);
    env.INTERNAL_TOKEN = "";
    expect((await call("list_test_principals")).isError).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
