import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSession } from "@proappstore/build-core";
import type { OAuthState } from "../../../mcp/src/oauth-state";
import { SESSION_SIGNING_KEY } from "../../config/shared";

const bindings = env as unknown as { OAUTH_KV: KVNamespace; OAUTH_STATE: DurableObjectNamespace<OAuthState> };
const origin = "https://mcp.proappstore.online";
const authority = () => bindings.OAUTH_STATE.get(bindings.OAUTH_STATE.idFromName("authority"));
const session = (uid: string) => mintSession({ uid, login: uid, roles: ["user"] }, SESSION_SIGNING_KEY);

async function access(uid: string, appId: string | null = null) {
  const token = crypto.randomUUID();
  await bindings.OAUTH_KV.put(`token:${token}`, JSON.stringify({ session: await session(uid), appId }), { expirationTtl: 3600 });
  return token;
}

async function rpc(token: string, method: string, params: unknown, path = "/mcp", oldSessionId?: string) {
  const response = await SELF.fetch(`${origin}${path}`, {
    method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26", ...(oldSessionId ? { "Mcp-Session-Id": oldSessionId } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  const body = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? JSON.parse(raw.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) : JSON.parse(raw);
  return { response, body };
}

async function authorization(appId: string | null = null) {
  const verifier = "runtime-verifier".padEnd(43, "x");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const code = crypto.randomUUID();
  await bindings.OAUTH_KV.put(`code:${code}`, JSON.stringify({
    session: await session("gh:1"), clientId: "runtime-client", redirectUri: "https://client.example/callback", codeChallenge: challenge, appId,
  }), { expirationTtl: 600 });
  return { code, verifier };
}

async function token(params: Record<string, string>) {
  const response = await SELF.fetch(`${origin}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
  });
  return { response, body: await response.json() as Record<string, string> };
}

const exchange = ({ code, verifier }: { code: string; verifier: string }) => token({
  grant_type: "authorization_code", code, code_verifier: verifier, client_id: "runtime-client", redirect_uri: "https://client.example/callback",
});
const refresh = (value: string) => token({ grant_type: "refresh_token", refresh_token: value, client_id: "runtime-client" });

describe("PAS MCP with real HTTP transport and durable OAuth storage", () => {
  it("publishes 68 annotated tools and no required token arguments on platform reads", async () => {
    const { response, body } = await rpc(await access("gh:1"), "tools/list", {});
    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(68);
    for (const tool of body.result.tools) {
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("token");
    }
    for (const name of ["list_apps", "schema_status", "list_scheduled_runs"]) {
      const tool = body.result.tools.find((t: { name: string }) => t.name === name);
      expect(tool.inputSchema.properties).not.toHaveProperty("token");
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
    const apps = await rpc(await access("gh:1"), "tools/call", { name: "list_apps", arguments: {} });
    expect(apps.body.result.isError).not.toBe(true);
    expect(apps.body.result.content[0].text).toContain("Example");
  });

  it("uses each request's identity even when a transport session id is reused", async () => {
    for (const uid of ["gh:1", "gh:2", "gh:1"]) {
      const { body } = await rpc(await access(uid), "tools/call", { name: "whoami", arguments: {} }, "/mcp", "reused-session");
      expect(body.result.content[0].text).toContain(`uid:       ${uid}`);
    }
  });

  it("rejects raw platform sessions and invalid browser origins at the transport", async () => {
    const raw = await SELF.fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${await session("gh:1")}` } });
    expect(raw.status).toBe(401);
    expect(raw.headers.get("WWW-Authenticate")).toContain("invalid_token");
    const forbidden = await SELF.fetch(`${origin}/mcp`, { headers: { Origin: "https://untrusted.example" } });
    expect(forbidden.status).toBe(403);
    await forbidden.text();
    const preflight = await SELF.fetch(`${origin}/mcp`, { method: "OPTIONS", headers: { Origin: origin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });

  it("uses manifest operations for scoped read/write annotations", async () => {
    const { body } = await rpc(await access("gh:1", "example"), "tools/list", {}, "/mcp/apps/example");
    const tools = body.result.tools;
    expect(tools.find((t: { name: string }) => t.name === "get_profile").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t: { name: string }) => t.name === "update_profile").annotations.readOnlyHint).toBe(false);
    expect(tools.some((t: { name: string }) => t.name === "provision_pas_app")).toBe(false);
    const schema = tools.find((t: { name: string }) => t.name === "get_profile").inputSchema;
    expect(schema.properties.limit).toMatchObject({ type: "integer", maximum: 50, default: 10 });
  });

  it("enforces manifest parameters, applies defaults and flags executor failures as tool errors", async () => {
    const credential = await access("gh:1", "example");
    const call = (name: string, args: Record<string, unknown>) => rpc(credential, "tools/call", { name, arguments: args }, "/mcp/apps/example");
    const defaults = await call("get_profile", {});
    expect(defaults.body.result.content[0].text).toContain('10');
    for (const limit of [1.5, 51]) {
      const invalid = await call("get_profile", { limit });
      expect(invalid.body.result.isError).toBe(true);
    }
    const failure = await call("update_profile", {});
    expect(failure.body.result.isError).toBe(true);
    expect(failure.body.result.content[0].text).toContain("No fixture for this route");
  });

  it("consumes a legacy authorization code exactly once under concurrent requests", async () => {
    const auth = await authorization();
    const results = await Promise.all([exchange(auth), exchange(auth)]);
    expect(results.map((r) => r.response.status).sort()).toEqual([200, 400]);
    expect(await bindings.OAUTH_KV.get(`code:${auth.code}`)).not.toBeNull();
    expect((await exchange(auth)).response.status).toBe(400); // no legacy resurrection
  });

  it("concurrent refresh retries return one successor and revocation takes effect immediately", async () => {
    const issued = await exchange(await authorization("example"));
    expect(issued.response.status).toBe(200);
    const results = await Promise.all([refresh(issued.body.refresh_token!), refresh(issued.body.refresh_token!)]);
    expect(results.map((r) => r.response.status)).toEqual([200, 200]);
    expect(results[0]!.body.access_token).toBe(results[1]!.body.access_token);
    expect(results[0]!.body.refresh_token).toBe(results[1]!.body.refresh_token);
    const current = results[0]!.body;
    const grants = await authority().grants("gh:1", "example");
    expect(grants).toHaveLength(1);
    expect(await authority().revoke("gh:1", grants[0]!.id)).toBe(true);
    expect(await authority().resolveToken(current.access_token!)).toBeNull();
    expect((await refresh(current.refresh_token!)).response.status).toBe(400);
  });

  it("reuse after the retry window revokes the family instead of branching it", async () => {
    const issued = await exchange(await authorization());
    const next = await refresh(issued.body.refresh_token!);
    await runInDurableObject(authority(), async (_instance, state) => {
      const key = `refresh:${issued.body.refresh_token}`;
      const value = state.storage.sql.exec<{ value: string }>("SELECT value FROM oauth_entries WHERE key = ?", key).one().value;
      const record = JSON.parse(value); record.usedAt -= 31;
      state.storage.sql.exec("UPDATE oauth_entries SET value = ? WHERE key = ?", JSON.stringify(record), key);
    });
    expect((await refresh(issued.body.refresh_token!)).response.status).toBe(400);
    expect((await refresh(next.body.refresh_token!)).response.status).toBe(400);
  });
});
