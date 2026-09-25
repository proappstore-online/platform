import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectDO } from './project-do.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * #2 — autoAdvance drives the runtime adapters. The DO runs over real SQLite;
 * the only things faked are the platform key vault (PAS_BACKEND) and the
 * model's HTTP endpoint (a canned Anthropic SSE stream). Everything between —
 * autoAdvance, dispatch, the CFNative adapter, the stream parser, the runner,
 * outcome transitions, message + cost persistence, broadcasts — is the real code.
 */
function fakeState() {
  const db = new DatabaseSync(':memory:');
  const broadcasts: Record<string, unknown>[] = [];
  const socket = { send: (data: string) => { broadcasts.push(JSON.parse(data) as Record<string, unknown>); } };
  const state = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          if (/^\s*select/i.test(sql)) return { toArray: () => db.prepare(sql).all(...(params as never[])) };
          if (params.length === 0) db.exec(sql); else db.prepare(sql).run(...(params as never[]));
          return { toArray: () => [] };
        },
      },
    },
    getWebSockets: () => [socket],
  };
  return { state, broadcasts, db };
}

/** One Anthropic streaming response: a single text block, end_turn, with usage. */
function anthropicSse(text: string): Response {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80 } },
    { type: 'message_stop' },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const OWNER = 'gh:owner';
const H = { 'X-User-Id': OWNER, 'Content-Type': 'application/json' };

function makeEnv(key: string | null) {
  const vault = vi.fn(async (req: Request) => Response.json({ key }));
  const env = {
    PAS_BACKEND: { fetch: vault },
    INTERNAL_TOKEN: 'internal-secret',
    AGENT_STORAGE: { put: vi.fn(async () => undefined), get: vi.fn(async () => null) },
    SESSION_SIGNING_KEY: 'k',
    PAS_API_BASE: 'https://api.test',
  };
  return { env, vault };
}

async function waitFor(pred: () => boolean, describe: () => string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for the pipeline: ${describe()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('autoAdvance → runtime adapters (#2)', () => {
  it('drives a ticket inbox → BA → Dev → QA → deploy → done with the vault key, persisting messages, cost and the trail', { timeout: 20_000 }, async () => {
    const { state, broadcasts, db } = fakeState();
    const { env, vault } = makeEnv('sk-ant-test');
    const model = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { system: { text: string }[]; messages: unknown[] };
      const sys = body.system.map((s) => s.text).join(' ');
      const role = /\bQA\b/.test(sys.slice(0, 400)) ? 'QA' : /\bDev\b|developer/i.test(sys.slice(0, 400)) ? 'Dev' : 'BA';
      return anthropicSse(`${role} output for this ticket. VERDICT: READY`);
    });
    vi.stubGlobal('fetch', model);
    const doInstance = new ProjectDO(state as never, env as never);

    // Create the project (seeds the role configs + template tree), press Play, file a ticket.
    expect((await doInstance.fetch(new Request('http://do/project', { method: 'PUT', headers: H, body: JSON.stringify({ name: 'Auto', slug: 'auto', ownerId: OWNER }) }))).status).toBe(200);
    expect((await doInstance.fetch(new Request('http://do/project/play', { method: 'POST', headers: H }))).status).toBe(200);
    const created = await doInstance.fetch(new Request('http://do/tickets', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Login page', rawIdea: 'users can sign in' }) }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const status = () => (db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status;
    const dump = () => `status=${status()} model calls=${model.mock.calls.length} trail=${JSON.stringify((db.prepare('SELECT type, detail FROM activity_log ORDER BY created_at, rowid').all() as { type: string; detail: string }[]).map((r) => `${r.type}: ${r.detail}`))}`;
    await waitFor(() => status() === 'done', dump);

    // Every stage ran an agent through the real adapter, against the mocked model, with the vault key.
    expect(model).toHaveBeenCalledTimes(3);
    for (const [url, init] of model.mock.calls) {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
    }
    // The key came from the platform vault over the service binding with the internal token — no user session anywhere.
    expect(vault).toHaveBeenCalled();
    const vaultReq = vault.mock.calls[0]![0];
    expect(new URL(vaultReq.url).pathname).toBe('/v1/keys/resolve/anthropic');
    expect(vaultReq.headers.get('X-Internal-Token')).toBe('internal-secret');
    expect(vaultReq.headers.get('X-Owner-Id')).toBe(OWNER);
    expect((db.prepare('SELECT owner_session_token AS t FROM project').get() as { t: string | null }).t).toBeNull();

    // Each role's output + cost is persisted on the ticket; spend rolls up to ticket and project.
    const messages = (db.prepare('SELECT author, body, cost_usd FROM messages WHERE ticket_id = ? ORDER BY created_at, rowid').all(id) as { author: string; body: string; cost_usd: number }[])
      .filter((m) => m.author !== 'po'); // the raw idea is stored as the PO's opening message
    expect(messages.map((m) => m.author)).toEqual(['BA', 'Dev', 'QA']);
    expect(messages.every((m) => m.cost_usd > 0 && /VERDICT: READY/.test(m.body))).toBe(true);
    expect((db.prepare('SELECT cost_spent_usd AS c FROM tickets WHERE id = ?').get(id) as { c: number }).c).toBeGreaterThan(0);
    expect((db.prepare('SELECT cost_spent_monthly_usd AS c FROM project').get() as { c: number }).c).toBeGreaterThan(0);
    // The BA's spec was stashed for approval; the outcome transitions ran in order.
    expect((db.prepare('SELECT spec_json AS s FROM tickets WHERE id = ?').get(id) as { s: string }).s).toContain('BA output');
    const transitions = broadcasts.filter((b) => b.type === 'transition').map((b) => `${b.from}→${b.to}`);
    expect(transitions).toEqual([
      'inbox→ba-refining', 'ba-refining→awaiting-approval', 'awaiting-approval→ready', 'ready→dev-active',
      'dev-active→qa-active', 'qa-active→deploying', 'deploying→done',
    ]);
    // Streamed to the WebSocket: run started / token deltas / run ended, per role; chat mirrors each reply.
    const roles = (t: string) => broadcasts.filter((b) => b.type === t).map((b) => b.role);
    expect(roles('agent-run-started')).toEqual(['BA', 'Dev', 'QA']);
    expect(roles('agent-run-ended')).toEqual(['BA', 'Dev', 'QA']);
    expect(broadcasts.filter((b) => b.type === 'agent-text').map((b) => String(b.text))).toEqual(['BA output for this ticket. VERDICT: READY', 'Dev output for this ticket. VERDICT: READY', 'QA output for this ticket. VERDICT: READY']);
    expect(roles('chat').filter((r) => r !== 'po')).toEqual(['BA', 'Dev', 'QA']); // the PO's opening message precedes them
    // The persisted trail records it all.
    const trail = (db.prepare('SELECT type, detail FROM activity_log ORDER BY created_at, rowid').all() as { type: string; detail: string }[]).map((r) => `${r.type}: ${r.detail}`);
    expect(trail).toEqual(expect.arrayContaining(['agent: BA started', 'agent: Dev started', 'agent: QA started', 'deploy: Deploy binding unavailable → done']));
    expect(trail.filter((t) => t.startsWith('cost: '))).toHaveLength(3);
  });

  it('with no key in the vault the ticket parks in needs-input with a clear ask, and no model call is made', { timeout: 20_000 }, async () => {
    const { state, broadcasts, db } = fakeState();
    const { env } = makeEnv(null);
    const model = vi.fn();
    vi.stubGlobal('fetch', model);
    const doInstance = new ProjectDO(state as never, env as never);
    await doInstance.fetch(new Request('http://do/project', { method: 'PUT', headers: H, body: JSON.stringify({ name: 'NoKey', slug: 'nokey', ownerId: OWNER }) }));
    await doInstance.fetch(new Request('http://do/project/play', { method: 'POST', headers: H }));
    const { id } = (await (await doInstance.fetch(new Request('http://do/tickets', { method: 'POST', headers: H, body: JSON.stringify({ title: 'T', rawIdea: 'x' }) }))).json()) as { id: string };
    const status = () => (db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status;
    await waitFor(() => status() === 'needs-input', () => status());
    expect(model).not.toHaveBeenCalled();
    const ask = broadcasts.find((b) => b.type === 'chat' && b.role === 'system');
    expect(String(ask?.body)).toContain('BA needs a anthropic API key');
    expect(broadcasts.some((b) => b.type === 'transition' && b.to === 'needs-input' && b.reason === 'agent-blocked')).toBe(true);
  });

  it('a runtime prepared without an executor refuses tool calls instead of reaching for a session', async () => {
    const { dispatchTool } = await import('./tool-dispatch.ts');
    const r = await dispatchTool({ id: 'c1', name: 'write_file', args: {} });
    expect(r).toMatchObject({ callId: 'c1', ok: false });
    expect(r.errorMessage).toContain('no executor');
  });
});
