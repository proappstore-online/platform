import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, seedApp, seedUser, session, resetTables } from './helpers';
import { STASH } from '../../../backend/src/__fixtures__/operator-view';
import { fetchTools, invalidateCache, registerAppDiscoveryTools, registerAppTools } from '../../../mcp/src/tool-loader';

// #240 regression: declaring an operator-view contract must not change MCP
// discovery. The MCP worker's own loader (per-app session and the shared
// endpoint's list_app_tools) runs against the real backend listing on real D1,
// for an app registered WITH a contract and one registered with the same tools
// and none. Both list their tools; neither leaks the contract or any SQL.

const api = { fetch: (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input, init) } as unknown as Fetcher;
const noUser = () => ({ userId: '', token: '', roles: [] as string[] });
const TOOL_NAMES = STASH.tools.map((t) => t.name).sort();
// Anything that only exists in the contract or the manifests' SQL.
const LEAKS = /operator_view|"resources"|"evidence"|"series"|_review\/|SELECT |UPDATE |INSERT |FROM members|password_hash|internal_score/;

afterEach(() => { fetchMock.assertNoPendingInterceptors(); invalidateCache(); });
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_operator_view', 'app_action_audit']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'other-owner');
  await seedApp('stash', 'gh:1');
  await seedApp('bingo', 'gh:2');
  const { operator_view: _contract, ...withoutContract } = STASH;
  for (const [appId, uid, body] of [['stash', 'gh:1', STASH], ['bingo', 'gh:2', withoutContract]] as const) {
    fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
    const put = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', body, await session(uid)));
    expect(put.status, await put.clone().text()).toBe(200);
  }
  // The premise: one app has a stored contract, the other has none.
  const stored = await env.DB.prepare('SELECT app_id FROM app_operator_view ORDER BY app_id').all<{ app_id: string }>();
  expect(stored.results.map((r) => r.app_id)).toEqual(['stash']);
});

describe('MCP discovery is unchanged by an operator-view contract (#240)', () => {
  for (const appId of ['stash', 'bingo']) {
    it(`${appId}: the public listing MCP reads answers 200 with every tool and nothing else`, async () => {
      const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toMatch(LEAKS);
      expect((JSON.parse(text) as { tools: { name: string }[] }).tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    });

    it(`${appId}: the per-app MCP session registers the same tools, with no SQL`, async () => {
      const tools = await fetchTools(api, BASE, appId);
      expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
      expect(JSON.stringify(tools)).not.toMatch(LEAKS);
      const names: string[] = [];
      const server = { tool: (name: string) => { names.push(name); } };
      expect(registerAppTools(server as never, tools, noUser, api, BASE, {}).sort()).toEqual(TOOL_NAMES);
    });

    it(`${appId}: list_app_tools on the shared /mcp endpoint lists them, params included, with no SQL`, async () => {
      const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>();
      const server = { tool: (name: string, _d: string, _s: unknown, h: never) => { handlers.set(name, h); } };
      registerAppDiscoveryTools(server as never, noUser, api, BASE, {});
      const text = (await handlers.get('list_app_tools')!({ app_id: appId, include_params: true })).content[0]!.text;
      expect(text).toContain(`# ${appId}: ${TOOL_NAMES.length} tool(s)`);
      for (const name of TOOL_NAMES) expect(text).toContain(name);
      expect(text).not.toMatch(LEAKS);
    });
  }
});
