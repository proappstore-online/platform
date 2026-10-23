import { env, SELF, runInDurableObject, fetchMock } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSession } from "@proappstore/build-core";
import type { OAuthState } from "../../../mcp/src/oauth-state";
import { SESSION_SIGNING_KEY, INTERNAL_TOKEN } from "../../config/shared";

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
  it('accepts the official native Codex client metadata in the Workers runtime', async () => {
    const clientId = 'https://chatgpt.com/oauth/codex/client.json';
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get('https://chatgpt.com').intercept({ path: '/oauth/codex/client.json', method: 'GET' }).reply(200, {
      client_id: clientId, client_uri: 'https://chatgpt.com/codex', application_type: 'native',
      redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
      token_endpoint_auth_method: 'none', token_endpoint_auth_methods_supported: ['none'],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'Codex',
      logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
    });
    try {
      const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: 'http://127.0.0.1:49152/callback', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: `${origin}/mcp` });
      const response = await SELF.fetch(`${origin}/authorize?${query}`);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain('Connect ProAppStore');
      fetchMock.assertNoPendingInterceptors();
    } finally {
      fetchMock.deactivate();
    }
  });

  it('rejects redirected client metadata without fetching the redirect destination', async () => {
    const clientId = 'https://chatgpt.com/redirected-client.json';
    let destinationCalls = 0;
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get('https://chatgpt.com').intercept({ path: '/redirected-client.json', method: 'GET' })
      .reply(302, '', { headers: { Location: 'https://untrusted.example/client.json' } });
    fetchMock.enableNetConnect(host => {
      if (host.includes('untrusted.example')) destinationCalls++;
      return false; // Observe attempted outbound connections without allowing one.
    });
    try {
      const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: 'http://127.0.0.1:49152/callback', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
      const response = await SELF.fetch(`${origin}/authorize?${query}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('invalid client_id');
      expect(destinationCalls).toBe(0);
      fetchMock.assertNoPendingInterceptors();
    } finally {
      fetchMock.disableNetConnect();
      fetchMock.deactivate();
    }
  });

  it('keeps the provisioning snapshot historical while reading fresh deployment and host health', async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get('https://api.github.com').intercept({
      path: '/repos/proappstore-online/example/actions/runs?per_page=5', method: 'GET',
    }).reply(200, { workflow_runs: [{ name: 'Deploy to R2', conclusion: 'success', status: 'completed', updated_at: '2026-10-23T00:00:00Z' }] });
    try {
      const result = await rpc(await access('gh:1'), 'tools/call', { name: 'provisioning_status', arguments: { app_id: 'example' } });
      expect(result.body.result.isError).not.toBe(true);
      const text = result.body.result.content[0].text;
      expect(text).toContain('Historical provisioning receipt');
      expect(text).toContain('~ host: Initial host returned 404');
      expect(text).toContain('+ Deploy to R2: success');
      expect(text).toContain('Current route health: ok');
      fetchMock.assertNoPendingInterceptors();
    } finally {
      fetchMock.deactivate();
    }
  });

  it("issues broker credentials through the internal service host using the public issuer", async () => {
    const requestId = `req_${'a'.repeat(43)}`;
    const ownerSession = await session('gh:1');
    const issue = (resource: string) => SELF.fetch('https://mcp/internal/broker/issue', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
      body: JSON.stringify({ session: ownerSession, owner_id: 'gh:1', resource, request_id: requestId }),
    });
    const invalid = await issue('https://untrusted.example/mcp');
    expect(invalid.status).toBe(403);
    await invalid.text();
    const response = await issue(`${origin}/mcp`);
    expect(response.status).toBe(200);
    const body = await response.json() as { access_token: string };
    const identity = await rpc(body.access_token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(identity.body.result.content[0].text).toContain('uid:       gh:1');
    expect(await authority().readSeen(requestId)).toBe(true);
  });

  it("publishes 71 annotated tools and no required token arguments on platform reads", async () => {
    const { response, body } = await rpc(await access("gh:1"), "tools/list", {});
    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(71);
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
