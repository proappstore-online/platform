import type { ProjectHost } from './project-host.ts';
import { json } from './store.ts';
import { handlePOChat } from './po-chat.ts';
import { handleArchitectChat, RESEARCH_THREAD, ARCHITECT_RUN_TIMEOUT_MS } from './architect-chat.ts';
import { handleQAChat } from './qa-chat.ts';
import { loadFiles, saveFiles, recallMemory } from './project-store.ts';
import { CHAT_THREADS, CHAT_ROLE, CHAT_STREAM_KEEPALIVE_MS, chatThreadOf, type ChatThread, type ChatStreamSubscriber } from './chat-thread.ts';
import { fetchDocs, syncFromGitHub } from './project-workspace.ts';
import { rememberFact } from './project-memory.ts';
import { touchUserActivity, autoAdvance } from './project-pipeline.ts';
import { nextSeq } from './project-tickets.ts';

/** `GET /chat/stream?thread=build|research|test|all` — a text/event-stream. */
export function openChatStream(h: ProjectHost, request: Request): Response {
  const requested = new URL(request.url).searchParams.get('thread') ?? 'build';
  if (!CHAT_THREADS.includes(requested as ChatThread) && requested !== 'all') {
    return json({ error: `thread must be one of: ${CHAT_THREADS.join(', ')}, all` }, 400);
  }
  const encoder = new TextEncoder();
  const subscribers = h.chatStreams;
  let subscriber: ChatStreamSubscriber;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      subscriber = {
        thread: requested as ChatThread | 'all',
        write: (chunk: string) => {
          try { controller.enqueue(encoder.encode(chunk)); return true; } catch { return false; }
        },
      };
      subscribers.add(subscriber);
      subscriber.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ thread: requested, subscribers: subscribers.size })}\n\n`);
      // A comment line every 15 s keeps proxies from closing an idle stream.
      keepAlive = setInterval(() => { if (!subscriber.write(': ping\n\n')) subscribers.delete(subscriber); }, CHAT_STREAM_KEEPALIVE_MS);
    },
    cancel: () => {
      if (keepAlive) clearInterval(keepAlive);
      subscribers.delete(subscriber);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Fan a broadcast event out to the SSE subscribers of its chat thread. */
export function publishChatEvent(h: ProjectHost, event: Record<string, unknown>, data: string): void {
  if (h.chatStreams.size === 0) return;
  const thread = chatThreadOf(event);
  if (!thread) return;
  const frame = `event: ${String(event.type)}\ndata: ${data}\n\n`;
  for (const sub of h.chatStreams) {
    if (sub.thread !== 'all' && sub.thread !== thread) continue;
    if (!sub.write(frame)) h.chatStreams.delete(sub);
  }
}

// Wipe the chat history (start the conversation from scratch). Tickets/messages
// are unaffected — this only clears the founder↔PO chat panel.
export function clearChat(h: ProjectHost, request: Request): Response {
  const thread = new URL(request.url).searchParams.get('thread') ?? 'build';
  h.state.storage.sql.exec('DELETE FROM chat_history WHERE thread = ?', thread);
  h.chatWindow = [];
  h.broadcast({ type: 'chat-cleared', thread });
  return json({ ok: true });
}

export function getChatHistory(h: ProjectHost, request: Request): Response {
  const thread = new URL(request.url).searchParams.get('thread') ?? 'build';
  const rows = h.state.storage.sql
    .exec('SELECT * FROM chat_history WHERE thread = ? ORDER BY created_at ASC', thread)
    .toArray();
  return json({
    messages: rows.map((r) => ({
      id: r.id as string,
      role: r.role as string,
      body: r.body as string,
      toolCall: r.tool_call_json ? JSON.parse(r.tool_call_json as string) : undefined,
      createdAt: r.created_at as number,
    })),
  });
}

export async function runArchitectChat(h: ProjectHost, request: Request): Promise<Response> {
  // Self-heal a leaked lock: if a prior run is "busy" but started longer ago
  // than its own hard timeout could allow (it hung, or the request died without
  // running `finally`), treat it as dead and take over — otherwise every KB
  // build 409s forever. MUST exceed the run timeout (derived, +2 min margin) so
  // an in-progress run is never wrongly cleared → two concurrent Architects
  // racing the same files. (Bug: this was a flat 5 min while the timeout grew to 6.)
  const STALE_LOCK_MS = ARCHITECT_RUN_TIMEOUT_MS + 2 * 60_000;
  if (h.architectChatBusy && Date.now() - h.architectChatStartedAt < STALE_LOCK_MS) {
    return json({ error: 'The Architect is already writing the Knowledge Base — give it a moment.' }, 409);
  }
  h.architectChatBusy = true;
  h.architectChatStartedAt = Date.now();
  try {
    return await handleArchitectChat({
      sql: h.state.storage.sql,
      env: h.env,
      getChatWindow: () => h.chatWindow,
      setChatWindow: (w) => { h.chatWindow = w; },
      touchUserActivity: () => touchUserActivity(h),
      syncFromGitHub: (reason) => syncFromGitHub(h, reason),
      broadcast: (e) => h.broadcast(e),
      loadFiles: () => loadFiles(h.state.storage.sql),
      saveFiles: (files) => saveFiles(h.state.storage.sql, files),
      recallMemory: () => recallMemory(h.state.storage.sql),
      rememberFact: (c, k, v) => rememberFact(h, c, k, v),
      fetchDocs: () => fetchDocs(h),
      logActivity: (type, detail, tid, meta) => h.logActivity(type, detail, tid, meta),
      // KB publishing disabled — KB stays private in the working tree.
      // The Research tab reads from /files/content (auth-gated), not the public site.
      // Re-enable when there's a per-project "publish KB" toggle.
      publishKb: () => { /* disabled — KB is private */ },
    }, request);
  } finally {
    h.architectChatBusy = false;
  }
}

export async function handleChatTurn(h: ProjectHost, request: Request): Promise<Response> {
  const peek = await request.clone().json().catch(() => ({})) as { thread?: string };
  const thread: ChatThread = peek.thread === 'research' ? 'research' : peek.thread === 'test' ? 'test' : 'build';
  const role = CHAT_ROLE[thread];
  h.broadcast({ type: 'chat-start', thread, role });
  let ok = false;
  try {
    const res = await handleChat(h, request);
    ok = res.ok;
    return res;
  } finally {
    h.broadcast({ type: 'chat-done', thread, role, ok });
  }
}

export async function handleChat(h: ProjectHost, request: Request): Promise<Response> {
  const peek = await request.clone().json().catch(() => ({})) as { thread?: string };
  if (peek.thread === 'research') {
    return runArchitectChat(h, request);
  }
  if (peek.thread === 'test') {
    return handleQAChat({
      sql: h.state.storage.sql,
      env: h.env,
      touchUserActivity: () => touchUserActivity(h),
      broadcast: (e) => h.broadcast(e),
      loadFiles: () => loadFiles(h.state.storage.sql),
      saveFiles: (files) => saveFiles(h.state.storage.sql, files),
      logActivity: (type, detail, tid, meta) => h.logActivity(type, detail, tid, meta),
    }, request);
  }
  return handlePOChat({
    sql: h.state.storage.sql,
    env: h.env,
    getChatWindow: () => h.chatWindow,
    setChatWindow: (w) => { h.chatWindow = w; },
    touchUserActivity: () => touchUserActivity(h),
    syncFromGitHub: (reason) => syncFromGitHub(h, reason),
    broadcast: (e) => h.broadcast(e),
    autoAdvance: () => autoAdvance(h),
    loadFiles: () => loadFiles(h.state.storage.sql),
    recallMemory: () => recallMemory(h.state.storage.sql),
    rememberFact: (c, k, v) => rememberFact(h, c, k, v),
    fetchDocs: () => fetchDocs(h),
    logActivity: (type, detail, tid, meta) => h.logActivity(type, detail, tid, meta),
    nextSeq: () => nextSeq(h),
  }, request);
}

export function buildKnowledgeBase(h: ProjectHost): Response {
  if (h.architectChatBusy) {
    return json({ ok: false, error: 'The Architect is already writing the Knowledge Base.' }, 409);
  }
  // Self-heal: physically drop any legacy kind=research ticket here too. The
  // store migration only runs on a cold isolate, but a long-lived DO can stay
  // "initialized" across a deploy and skip it — so clean it at this reliable
  // runtime point as well (the board already hides it; this removes the row).
  h.state.storage.sql.exec("DELETE FROM tickets WHERE kind = 'research'");
  const hasKb = [...loadFiles(h.state.storage.sql).keys()].some(
    (p) => p === 'KNOWLEDGE.md' || /^docs\/.+\.(md|markdown)$/i.test(p),
  );
  const proj = h.state.storage.sql
    .exec('SELECT app_idea FROM project LIMIT 1')
    .toArray()[0] as { app_idea: string | null } | undefined;
  const idea = proj?.app_idea?.trim();
  const message = hasKb
    ? 'Re-research this app and refresh the Knowledge Base (KNOWLEDGE.md + docs/) — update anything stale and keep every SDK fact correct.'
    : `Research this app and write its Knowledge Base — KNOWLEDGE.md plus docs/ — as the team's source of truth.${idea ? ` The app idea: ${idea}` : ''}`;

  // Drive the Architect on the Research thread via the SAME guarded path as the
  // chat (runArchitectChat owns the architectChatBusy lock — it sets the flag
  // synchronously at its top, so this fire-and-forget can't race a chat send).
  // Its progress streams over the WS; we don't await the reply here.
  const chatReq = new Request('https://do/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thread: RESEARCH_THREAD, message }),
  });
  void runArchitectChat(h, chatReq)
    .catch((e) => {
      try { h.logActivity('error', `KB build crashed: ${e instanceof Error ? e.message : String(e)}`, null); } catch { /* noop */ }
    })
    .finally(() => { touchUserActivity(h); });
  return json({ ok: true, started: true });
}
