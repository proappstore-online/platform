import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectDO, chatThreadOf } from './project-do.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Same minimal DurableObjectState stub as project-do-update-ticket.test.ts. */
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

const OWNER = 'user-1';

/** Parse the SSE frames read so far into { event, data } records. */
function frames(text: string): { event: string; data: Record<string, unknown> }[] {
  return text.split('\n\n').filter((f) => f.includes('event: ')).map((f) => {
    const event = /event: (.+)/.exec(f)![1]!;
    const data = JSON.parse(/data: (.+)/.exec(f)![1]!) as Record<string, unknown>;
    return { event, data };
  });
}

async function open(doInstance: ProjectDO, query = '?thread=build') {
  const res = await doInstance.fetch(new Request(`http://do/chat/stream${query}`, { headers: { 'X-User-Id': OWNER } }));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (pred: (f: ReturnType<typeof frames>) => boolean) => {
    while (!pred(frames(buffer))) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return frames(buffer);
  };
  return { res, reader, readUntil };
}

describe('GET /chat/stream (#8): chat over Server-Sent Events', () => {
  it('answers text/event-stream with a ready frame and rejects an unknown thread', async () => {
    const { state } = fakeState();
    const doInstance = new ProjectDO(state as never, {} as never);
    const { res, reader, readUntil } = await open(doInstance);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-store');
    const [ready] = await readUntil((f) => f.length >= 1);
    expect(ready).toEqual({ event: 'ready', data: { thread: 'build', subscribers: 1 } });
    await reader.cancel();

    const bad = await doInstance.fetch(new Request('http://do/chat/stream?thread=nope', { headers: { 'X-User-Id': OWNER } }));
    expect(bad.status).toBe(400);
    expect((await doInstance.fetch(new Request('http://do/chat/stream'))).status).toBe(403); // no identity
  });

  it('delivers only its thread\'s events, token deltas included, in the shape the WebSocket sends', async () => {
    const { state, broadcasts } = fakeState();
    const doInstance = new ProjectDO(state as never, {} as never);
    const build = await open(doInstance, '?thread=build');
    const research = await open(doInstance, '?thread=research');
    const all = await open(doInstance, '?thread=all');
    await Promise.all([build.readUntil((f) => f.length >= 1), research.readUntil((f) => f.length >= 1), all.readUntil((f) => f.length >= 1)]);

    const broadcast = (e: Record<string, unknown>) => (doInstance as unknown as { broadcast(e: Record<string, unknown>): void }).broadcast(e);
    broadcast({ type: 'agent-text', role: 'PO', text: 'Hel' });
    broadcast({ type: 'agent-text', role: 'PO', text: 'lo' });
    broadcast({ type: 'agent-text', role: 'Architect', text: 'KB…' });
    broadcast({ type: 'agent-text', role: 'Dev', ticketId: 't1', text: 'code' }); // a ticket run: not chat
    broadcast({ type: 'ticket-created', ticket: { id: 't2' } });                 // board event: not chat
    broadcast({ type: 'chat', role: 'po', body: 'Hello', id: 'm1' });
    broadcast({ type: 'chat', role: 'QA', thread: 'test', body: 'tests', id: 'm2' });

    const b = await build.readUntil((f) => f.length >= 4);
    expect(b.slice(1)).toEqual([
      { event: 'agent-text', data: { type: 'agent-text', role: 'PO', text: 'Hel' } },
      { event: 'agent-text', data: { type: 'agent-text', role: 'PO', text: 'lo' } },
      { event: 'chat', data: { type: 'chat', role: 'po', body: 'Hello', id: 'm1' } },
    ]);
    const r = await research.readUntil((f) => f.length >= 2);
    expect(r.slice(1)).toEqual([{ event: 'agent-text', data: { type: 'agent-text', role: 'Architect', text: 'KB…' } }]);
    const a = await all.readUntil((f) => f.length >= 6);
    expect(a.slice(1).map((f) => f.event)).toEqual(['agent-text', 'agent-text', 'agent-text', 'chat', 'chat']);
    // The WebSocket still gets everything.
    expect(broadcasts.map((e) => e.type)).toEqual(['agent-text', 'agent-text', 'agent-text', 'agent-text', 'ticket-created', 'chat', 'chat']);
    await Promise.all([build.reader.cancel(), research.reader.cancel(), all.reader.cancel()]);
  });

  it('brackets every chat turn with chat-start / chat-done (typing indicator), ok:false when the turn is refused', async () => {
    const { state, broadcasts, db } = fakeState();
    const doInstance = new ProjectDO(state as never, {} as never);
    await doInstance.fetch(new Request('http://do/tickets', { headers: { 'X-User-Id': OWNER } }));
    db.exec(`INSERT INTO project (id, owner_id, name, slug, created_at) VALUES ('p1', '${OWNER}', 'Probe', 'probe', 1)`);
    const stream = await open(doInstance, '?thread=build');
    await stream.readUntil((f) => f.length >= 1);

    const res = await doInstance.fetch(new Request('http://do/chat', {
      method: 'POST', headers: { 'X-User-Id': OWNER, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '   ' }),
    }));
    expect(res.status).toBe(400);
    const f = await stream.readUntil((f) => f.some((x) => x.event === 'chat-done'));
    expect(f.slice(1)).toEqual([
      { event: 'chat-start', data: { type: 'chat-start', thread: 'build', role: 'PO' } },
      { event: 'chat-done', data: { type: 'chat-done', thread: 'build', role: 'PO', ok: false } },
    ]);
    expect(broadcasts.map((e) => e.type)).toEqual(['chat-start', 'chat-done']);
    await stream.reader.cancel();

    // A research-thread turn reports the Architect.
    const research = await open(doInstance, '?thread=research');
    await research.readUntil((f) => f.length >= 1);
    await doInstance.fetch(new Request('http://do/chat', {
      method: 'POST', headers: { 'X-User-Id': OWNER, 'Content-Type': 'application/json' }, body: JSON.stringify({ thread: 'research', message: '' }),
    }));
    const rf = await research.readUntil((f) => f.some((x) => x.event === 'chat-done'));
    expect(rf.slice(1)[0]).toEqual({ event: 'chat-start', data: { type: 'chat-start', thread: 'research', role: 'Architect' } });
    await research.reader.cancel();
  });

  it('a subscriber that went away is dropped on the next event, without disturbing the others', async () => {
    const { state } = fakeState();
    const doInstance = new ProjectDO(state as never, {} as never);
    const gone = await open(doInstance);
    const stays = await open(doInstance);
    await Promise.all([gone.readUntil((f) => f.length >= 1), stays.readUntil((f) => f.length >= 1)]);
    await gone.reader.cancel();
    const broadcast = (e: Record<string, unknown>) => (doInstance as unknown as { broadcast(e: Record<string, unknown>): void }).broadcast(e);
    broadcast({ type: 'agent-text', role: 'PO', text: 'x' });
    const f = await stays.readUntil((f) => f.length >= 2);
    expect(f[1]).toEqual({ event: 'agent-text', data: { type: 'agent-text', role: 'PO', text: 'x' } });
    expect((doInstance as unknown as { chatStreams: Set<unknown> }).chatStreams.size).toBe(1);
    await stays.reader.cancel();
  });
});

describe('chatThreadOf', () => {
  it('maps chat events to their thread and ignores everything else', () => {
    expect(chatThreadOf({ type: 'agent-text', role: 'PO' })).toBe('build');
    expect(chatThreadOf({ type: 'agent-text', role: 'Architect' })).toBe('research');
    expect(chatThreadOf({ type: 'agent-text', role: 'QA' })).toBe('test');
    expect(chatThreadOf({ type: 'chat', role: 'user' })).toBe('build');
    expect(chatThreadOf({ type: 'chat', role: 'user', thread: 'research' })).toBe('research');
    expect(chatThreadOf({ type: 'chat-done', thread: 'test', role: 'QA' })).toBe('test');
    expect(chatThreadOf({ type: 'agent-run-started', role: 'PO' })).toBe('build');
    expect(chatThreadOf({ type: 'agent-text', role: 'Dev', ticketId: 't1' })).toBeNull();
    expect(chatThreadOf({ type: 'transition', ticketId: 't1' })).toBeNull();
    expect(chatThreadOf({ type: 'files-synced', count: 2 })).toBeNull();
  });
});
