import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, freshSlug, json, resetTables, session } from './helpers';

beforeEach(resetTables);

/**
 * #8 end to end in workerd: a client subscribes to a project's chat over SSE
 * through the router (with ?token=, as a browser EventSource must), then a chat
 * turn runs in the DO. No model key is reachable here (PAS_BACKEND is an echo),
 * so the PO answers through its rule-based fallback — which still exercises
 * the whole bracket: chat-start, the user's message, the agent signal, the
 * persisted reply, chat-done.
 */
describe('GET /v1/projects/:slug/chat/stream', () => {
  it('streams the chat turn as Server-Sent Events to a subscriber authenticated by ?token=', async () => {
    const slug = freshSlug('sse');
    const owner = await session('gh:1', 'alice');
    expect((await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'SSE App', slug }, owner))).status).toBe(200);

    const res = await SELF.fetch(`${BASE}/v1/projects/${slug}/chat/stream?thread=build&token=${encodeURIComponent(owner)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = () => buffer.split('\n\n').filter((f) => f.startsWith('event: ') || f.includes('\nevent: ')).map((f) => ({
      event: /event: (.+)/.exec(f)![1]!, data: JSON.parse(/data: (.+)/.exec(f)![1]!) as Record<string, unknown>,
    }));
    const readUntil = async (done: () => boolean) => {
      while (!done()) { const { value, done: end } = await reader.read(); if (end) break; buffer += decoder.decode(value, { stream: true }); }
    };
    await readUntil(() => events().some((e) => e.event === 'ready'));

    const turn = await SELF.fetch(`${BASE}/v1/projects/${slug}/chat`, json('POST', { message: 'What should we build first?' }, owner));
    expect(turn.status).toBe(200);
    const reply = (await turn.json()) as { role: string; body: string };
    expect(reply.role).toBe('po');

    await readUntil(() => events().some((e) => e.event === 'chat-done'));
    const seen = events();
    const types = seen.map((e) => e.event);
    expect(types[0]).toBe('ready');
    expect(types).toContain('chat-start');
    expect(types.indexOf('chat-start')).toBeLessThan(types.indexOf('chat-done'));
    expect(seen.find((e) => e.event === 'chat' && e.data.role === 'user')?.data).toMatchObject({ body: 'What should we build first?' });
    expect(seen.find((e) => e.event === 'chat' && e.data.role === 'po')?.data).toMatchObject({ body: reply.body });
    expect(seen.find((e) => e.event === 'chat-done')?.data).toEqual({ type: 'chat-done', thread: 'build', role: 'PO', ok: true });
    await reader.cancel();

    // No session → 401 from the router, before the DO.
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}/chat/stream`)).status).toBe(401);
  });
});
