import { describe, it, expect, afterEach } from 'vitest';
import { OpenAIResponsesRuntime } from './openai-responses.ts';
import type { PrepareContext, StreamEvent, ToolCall, ToolResult } from '../types.ts';

function msgResp(text: string, status: 'completed' | 'incomplete') {
  return {
    id: `r_${status}`,
    status,
    output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
  };
}

function fnResp(name: string, args: Record<string, unknown>) {
  return {
    id: 'r_fn',
    status: 'completed',
    output: [{ type: 'function_call', id: 'fc', call_id: 'c1', name, arguments: JSON.stringify(args), status: 'completed' }],
    usage: { input_tokens: 10, output_tokens: 50, total_tokens: 60 },
  };
}

function mockOpenAI(responses: unknown[]) {
  const calls = { count: 0, bodies: [] as { input: unknown }[] };
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.bodies.push(JSON.parse(init.body));
    const r = responses[Math.min(calls.count, responses.length - 1)];
    calls.count += 1;
    return { ok: true, status: 200, json: async () => r };
  }) as unknown as typeof fetch;
  return calls;
}

async function run(opts?: { dispatch?: (c: ToolCall) => Promise<ToolResult> }): Promise<StreamEvent[]> {
  const ctx: PrepareContext = {
    projectId: 'proj',
    ticketId: 'tick',
    byoKey: 'sk-test',
    role: { role: 'Dev', runtime: 'openai-responses', model: 'gpt-4o', spineTools: ['read_file'], vendorTools: [] },
    dispatch: opts?.dispatch,
  };
  const runtime = new OpenAIResponsesRuntime();
  const handle = await runtime.prepare(ctx);
  const events: StreamEvent[] = [];
  for await (const ev of runtime.run(handle, [{
    id: 'm', ticketId: 'tick', author: 'po', body: 'go', createdAt: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
  }])) events.push(ev);
  return events;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('OpenAIResponsesRuntime run loop', () => {
  // Parity with cf-native: a truncated ('incomplete') turn with no function calls
  // must continue the run, not end it.
  it('continues after an incomplete (truncated) response instead of ending', async () => {
    const calls = mockOpenAI([msgResp('planning…', 'incomplete'), msgResp('done', 'completed')]);
    const events = await run();

    expect(calls.count).toBe(2);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(JSON.stringify(calls.bodies[1]!.input)).toContain('Continue.');
  });

  it('ends on a completed response with no function calls', async () => {
    const calls = mockOpenAI([msgResp('all set', 'completed')]);
    const events = await run();
    expect(calls.count).toBe(1);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('heartbeats carry the running cost so the live cost tile updates mid-run', async () => {
    // A fn-call turn accrues tokens, then completes. agent-runner reads
    // `ev.costUsd ?? 0` off each heartbeat — if the heartbeat omitted cost, an
    // OpenAI agent would broadcast $0.00 every beat until 'done'. Mirrors cf-native.
    mockOpenAI([fnResp('read_file', { app_id: 'x', path: 'p' }), msgResp('done', 'completed')]);
    const events = await run({
      dispatch: async (c) => ({ callId: c.id, ok: true, data: 'contents', durationMs: 0 }),
    });
    const heartbeats = events.filter((e) => e.type === 'heartbeat') as { costUsd?: number }[];
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats.every((h) => typeof h.costUsd === 'number')).toBe(true);
    // After the first response's tokens accrue, a later heartbeat reports real cost.
    expect(heartbeats.some((h) => (h.costUsd ?? 0) > 0)).toBe(true);
  });

  it('executes function calls then completes', async () => {
    const dispatched: ToolCall[] = [];
    const calls = mockOpenAI([fnResp('read_file', { app_id: 'x', path: 'p' }), msgResp('reviewed', 'completed')]);
    const events = await run({
      dispatch: async (c) => { dispatched.push(c); return { callId: c.id, ok: true, data: 'contents', durationMs: 0 }; },
    });

    expect(calls.count).toBe(2);
    expect(dispatched.map((c) => c.name)).toEqual(['read_file']);
    expect(events.some((e) => e.type === 'tool-call')).toBe(true);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});
