import { describe, it, expect, afterEach } from 'vitest';
import { CFNativeRuntime } from './cf-native.ts';
import type { PrepareContext, StreamEvent, ToolCall, ToolResult } from '../types.ts';

// ─── Anthropic response fixtures ─────────────────────────────────────────────

function textResp(text: string, stop: 'end_turn' | 'max_tokens', out = 100) {
  return {
    id: 'msg',
    content: [{ type: 'text', text }],
    stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: out },
    model: 'claude-sonnet-4-6',
  };
}

function toolResp(name: string, input: unknown) {
  return {
    id: 'msg',
    content: [{ type: 'tool_use', id: 'tu_1', name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 50 },
    model: 'claude-sonnet-4-6',
  };
}

// Encode an Anthropic response as the SSE stream the runtime now parses.
function sseFromResponse(resp: {
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}): ReadableStream<Uint8Array> {
  const lines: string[] = [];
  const push = (o: Record<string, unknown>) => lines.push(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  push({ type: 'message_start', message: { usage: { input_tokens: resp.usage.input_tokens, output_tokens: 0 } } });
  resp.content.forEach((b, i) => {
    if (b.type === 'text') {
      push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
      push({ type: 'content_block_stop', index: i });
    } else if (b.type === 'tool_use') {
      push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
      push({ type: 'content_block_stop', index: i });
    }
  });
  push({ type: 'message_delta', delta: { stop_reason: resp.stop_reason }, usage: { output_tokens: resp.usage.output_tokens } });
  push({ type: 'message_stop' });
  const bytes = new TextEncoder().encode(lines.join(''));
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

type Resp = { content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } };

// Mock global fetch to stream a queue of Anthropic responses; returns a call counter.
function mockAnthropic(responses: Resp[]) {
  const calls = { count: 0, bodies: [] as unknown[] };
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.bodies.push(JSON.parse(init.body));
    const r = responses[Math.min(calls.count, responses.length - 1)]!;
    calls.count += 1;
    return { ok: true, status: 200, body: sseFromResponse(r) };
  }) as unknown as typeof fetch;
  return calls;
}

async function prepareHandle(opts?: { dispatch?: (c: ToolCall) => Promise<ToolResult>; maxTokens?: number }) {
  const ctx: PrepareContext = {
    projectId: 'proj',
    ticketId: 'tick',
    byoKey: 'sk-test',
    role: {
      role: 'Dev',
      runtime: 'cf-native',
      model: 'claude-sonnet-4-6',
      ...(opts?.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
      spineTools: ['read_file', 'batch_write_files'],
      vendorTools: [],
    },
    dispatch: opts?.dispatch,
  };
  return new CFNativeRuntime().prepare(ctx);
}

async function collect(handle: Awaited<ReturnType<typeof prepareHandle>>): Promise<StreamEvent[]> {
  const runtime = new CFNativeRuntime();
  const events: StreamEvent[] = [];
  for await (const ev of runtime.run(handle, [])) events.push(ev);
  return events;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('CFNativeRuntime run loop', () => {
  // Regression: a max_tokens truncation with no tool calls used to be treated as
  // "done", ending the run before the Dev ever wrote a file (agents "going in
  // circles"). It must now continue the loop until a genuine end_turn.
  it('continues after a max_tokens truncation instead of ending the run', async () => {
    const calls = mockAnthropic([
      textResp('Now I will build the files…', 'max_tokens'),
      textResp('Done.', 'end_turn'),
    ]);
    const events = await collect(await prepareHandle());

    expect(calls.count).toBe(2); // did NOT stop after the truncated turn
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    // The second request carries the "Continue." nudge we injected.
    const lastBody = calls.bodies[1] as { messages: { role: string; content: unknown }[] };
    const lastMsg = lastBody.messages[lastBody.messages.length - 1];
    expect(JSON.stringify(lastMsg)).toContain('Continue.');
  });

  it('uses the role-configured max_tokens (default 16384, override honored)', async () => {
    const def = mockAnthropic([textResp('ok', 'end_turn')]);
    await collect(await prepareHandle());
    expect((def.bodies[0] as { max_tokens: number }).max_tokens).toBe(16384);

    const custom = mockAnthropic([textResp('ok', 'end_turn')]);
    await collect(await prepareHandle({ maxTokens: 2048 }));
    expect((custom.bodies[0] as { max_tokens: number }).max_tokens).toBe(2048);
  });

  it('ends immediately on a genuine end_turn with no tool calls', async () => {
    const calls = mockAnthropic([textResp('All set.', 'end_turn')]);
    const events = await collect(await prepareHandle());

    expect(calls.count).toBe(1);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('executes tool calls, feeds results back, then completes', async () => {
    const dispatched: ToolCall[] = [];
    const calls = mockAnthropic([
      toolResp('read_file', { app_id: 'interns', path: 'src/main.tsx' }),
      textResp('Reviewed.', 'end_turn'),
    ]);
    const events = await collect(await prepareHandle({
      dispatch: async (c) => { dispatched.push(c); return { callId: c.id, ok: true, data: 'file contents', durationMs: 0 }; },
    }));

    expect(calls.count).toBe(2);
    expect(dispatched.map((c) => c.name)).toEqual(['read_file']);
    expect(events.some((e) => e.type === 'tool-call')).toBe(true);
    expect(events.some((e) => e.type === 'tool-result')).toBe(true);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    // The tool result was fed back as a user message on the follow-up request.
    const followup = calls.bodies[1] as { messages: { role: string; content: { type: string }[] }[] };
    const hasToolResult = followup.messages.some((m) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    expect(hasToolResult).toBe(true);
  });

  it('surfaces a sanitized error on an API failure (no raw upstream body)', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const events = await collect(await prepareHandle());
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toContain('authentication');
  });
});
