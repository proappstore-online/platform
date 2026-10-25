import { describe, expect, it } from 'vitest';
import { buildKnowledgeBase, clearChat, getChatHistory, openChatStream, publishChatEvent, runArchitectChat } from './project-chat.ts';
import { fakeHost, req, seedProject } from './project-test-host.ts';

const say = (db: ReturnType<typeof fakeHost>['db'], thread: string, id: string, body: string, at: number) =>
  db.prepare('INSERT INTO chat_history (id, role, body, created_at, thread) VALUES (?, ?, ?, ?, ?)').run(id, 'po', body, at, thread);

describe('chat history', () => {
  it('returns one thread oldest first, defaulting to build', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    say(db, 'build', 'b2', 'second', 2);
    say(db, 'build', 'b1', 'first', 1);
    say(db, 'research', 'r1', 'kb', 1);
    const { messages } = (await getChatHistory(host, req('/chat/history')).json()) as { messages: { body: string }[] };
    expect(messages.map((m) => m.body)).toEqual(['first', 'second']);
    const research = (await getChatHistory(host, req('/chat/history?thread=research')).json()) as { messages: { body: string }[] };
    expect(research.messages.map((m) => m.body)).toEqual(['kb']);
  });

  it('clears only the requested thread, resets the throttle window and announces it', () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    say(db, 'build', 'b1', 'x', 1);
    say(db, 'research', 'r1', 'y', 1);
    host.chatWindow = [1, 2, 3];
    clearChat(host, req('/chat/history?thread=build', { method: 'DELETE' }));
    expect(db.prepare('SELECT thread FROM chat_history').all()).toEqual([{ thread: 'research' }]);
    expect(host.chatWindow).toEqual([]);
    expect(broadcasts).toContainEqual({ type: 'chat-cleared', thread: 'build' });
  });
});

describe('Architect lock', () => {
  it('refuses a second Architect run while one is in flight', async () => {
    const { host } = fakeHost();
    host.architectChatBusy = true;
    host.architectChatStartedAt = Date.now();
    const res = await runArchitectChat(host, req('/chat', { method: 'POST', body: { thread: 'research', message: 'hi' } }));
    expect(res.status).toBe(409);
  });

  it('refuses to start a KB build while the Architect is busy', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    host.architectChatBusy = true;
    const res = buildKnowledgeBase(host);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'The Architect is already writing the Knowledge Base.' });
  });
});

describe('chat streams', () => {
  it('rejects an unknown thread', async () => {
    const { host } = fakeHost();
    const res = openChatStream(host, req('/chat/stream?thread=nope'));
    expect(res.status).toBe(400);
  });

  it('opens an event stream and fans events out to the matching thread only', async () => {
    const { host } = fakeHost();
    const res = openChatStream(host, req('/chat/stream?thread=research'));
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(host.chatStreams.size).toBe(1);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('event: ready');
    const chat = { type: 'chat', role: 'architect', thread: 'research', body: 'hello' };
    publishChatEvent(host, chat, JSON.stringify(chat));
    expect(decoder.decode((await reader.read()).value)).toContain('event: chat');
    // An event for another thread is not delivered: the next frame is the research one.
    const other = { type: 'chat', role: 'po', thread: 'build', body: 'nope' };
    publishChatEvent(host, other, JSON.stringify(other));
    const again = { type: 'chat', role: 'architect', thread: 'research', body: 'second' };
    publishChatEvent(host, again, JSON.stringify(again));
    const next = decoder.decode((await reader.read()).value);
    expect(next).toContain('second');
    expect(next).not.toContain('nope');
    await reader.cancel();
    expect(host.chatStreams.size).toBe(0);
  });
});
