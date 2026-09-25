import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectDO } from './project-do.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function fakeState() {
  const db = new DatabaseSync(':memory:');
  const broadcasts: Record<string, unknown>[] = [];
  const socket = { send: (data: string) => { broadcasts.push(JSON.parse(data) as Record<string, unknown>); } };
  const state = {
    storage: { sql: { exec(sql: string, ...params: unknown[]) {
      if (/^\s*select/i.test(sql)) return { toArray: () => db.prepare(sql).all(...(params as never[])) };
      if (params.length === 0) db.exec(sql); else db.prepare(sql).run(...(params as never[]));
      return { toArray: () => [] };
    } } },
    getWebSockets: () => [socket],
  };
  return { state, broadcasts, db };
}

function anthropicSse(text: string): Response {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 500, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const OWNER = 'gh:owner';
const H = { 'X-User-Id': OWNER, 'Content-Type': 'application/json' };
const GW = { AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'pas-agent-teams', AI_GATEWAY_TOKEN: 'gw-tok' };

afterEach(() => vi.unstubAllGlobals());

/** #22 end to end: the PO chat (a chat-style call, not a build runtime) goes through the gateway, with the fallback. */
describe('PO chat through AI Gateway (#22)', () => {
  async function project(envExtra: Record<string, unknown>) {
    const { state, broadcasts } = fakeState();
    const env = { PAS_BACKEND: { fetch: vi.fn(async (_r: Request) => Response.json({ key: 'sk-ant-byo' })) }, INTERNAL_TOKEN: 'internal', AGENT_STORAGE: { put: vi.fn(), get: vi.fn(async () => null) }, ...envExtra };
    const doInstance = new ProjectDO(state as never, env as never);
    await doInstance.fetch(new Request('http://do/project', { method: 'PUT', headers: H, body: JSON.stringify({ name: 'GW', slug: 'gw', ownerId: OWNER }) }));
    return { doInstance, broadcasts };
  }
  const chat = (d: ProjectDO) => d.fetch(new Request('http://do/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'What next?' }) }));

  it('routes the PO call through the gateway with the gateway token and the BYO key; the reply is persisted', async () => {
    const model = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => anthropicSse('Ship the login page first.'));
    vi.stubGlobal('fetch', model);
    const { doInstance } = await project(GW);
    const res = await chat(doInstance);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { body: string }).body).toBe('Ship the login page first.');
    expect(model).toHaveBeenCalledTimes(1);
    const [url, init] = model.mock.calls[0]!;
    expect(String(url)).toBe('https://gateway.ai.cloudflare.com/v1/acct/pas-agent-teams/anthropic/v1/messages');
    const headers = init!.headers as Record<string, string>;
    expect(headers['cf-aig-authorization']).toBe('Bearer gw-tok');
    expect(headers['x-api-key']).toBe('sk-ant-byo');
    const body = JSON.parse(String(init!.body)) as { model: string; stream: boolean };
    expect(body).toMatchObject({ model: 'claude-sonnet-4-6', stream: true });
  });

  it('falls back to Anthropic directly when the gateway is down, without the gateway token', async () => {
    let n = 0;
    const model = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (++n === 1 ? new Response('', { status: 502 }) : anthropicSse('Still here.')));
    vi.stubGlobal('fetch', model);
    const { doInstance } = await project(GW);
    const res = await chat(doInstance);
    expect(((await res.json()) as { body: string }).body).toBe('Still here.');
    expect(model.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://gateway.ai.cloudflare.com/v1/acct/pas-agent-teams/anthropic/v1/messages',
      'https://api.anthropic.com/v1/messages',
    ]);
    expect((model.mock.calls[1]![1]!.headers as Record<string, string>)['cf-aig-authorization']).toBeUndefined();
  });

  it('unconfigured: the PO call goes to Anthropic directly with no gateway header', async () => {
    const model = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => anthropicSse('Direct.'));
    vi.stubGlobal('fetch', model);
    const { doInstance } = await project({});
    await chat(doInstance);
    expect(String(model.mock.calls[0]![0])).toBe('https://api.anthropic.com/v1/messages');
    expect(model.mock.calls[0]![1]!.headers).not.toHaveProperty('cf-aig-authorization');
  });
});
