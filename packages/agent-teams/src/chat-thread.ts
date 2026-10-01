/** Chat streaming (#8): which thread a broadcast belongs to, for `GET /chat/stream` subscribers. */

export const CHAT_THREADS = ['build', 'research', 'test'] as const;
export type ChatThread = (typeof CHAT_THREADS)[number];
/** The agent that answers each thread — what `chat-start` / `chat-done` report. */
export const CHAT_ROLE: Record<ChatThread, string> = { build: 'PO', research: 'Architect', test: 'QA' };
export const CHAT_STREAM_KEEPALIVE_MS = 15_000;

export interface ChatStreamSubscriber {
  thread: ChatThread | 'all';
  /** Returns false once the client is gone. */
  write(chunk: string): boolean;
}

/**
 * Which chat thread a broadcast event belongs to, or null when it is not a chat
 * event (ticket runs carry a `ticketId`; board events are not chat at all).
 * Thread comes from the event when present (`chat` on research/test, the
 * `chat-start` / `chat-done` bracket), else from the agent role: the Architect
 * answers research, QA answers test, the PO answers build.
 */
export function chatThreadOf(event: Record<string, unknown>): ChatThread | null {
  const type = String(event.type ?? '');
  if (!['chat', 'chat-start', 'chat-done', 'agent-text', 'agent-run-started', 'agent-heartbeat'].includes(type)) return null;
  if (event.ticketId) return null;
  if (typeof event.thread === 'string' && CHAT_THREADS.includes(event.thread as ChatThread)) return event.thread as ChatThread;
  const role = String(event.role ?? '').toLowerCase();
  if (role === 'architect') return 'research';
  if (role === 'qa') return 'test';
  return 'build';
}
