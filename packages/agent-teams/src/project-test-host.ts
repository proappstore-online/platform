import { createRequire } from 'node:module';
import type { ProjectHost } from './project-host.ts';
import { applySchema } from './project-schema.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export const OWNER = 'gh:owner';

/**
 * A ProjectHost over an in-memory SQLite, for unit-testing the modules the DO
 * delegates to without a Durable Object runtime. The schema is applied the same
 * way the DO applies it.
 */
export function fakeHost(env: Record<string, unknown> = {}) {
  const db = new DatabaseSync(':memory:');
  const broadcasts: Record<string, unknown>[] = [];
  const activity: { type: string; detail: string; ticketId: string | null }[] = [];
  const alarm: { at: number | null } = { at: null };
  const sql = {
    exec(query: string, ...params: unknown[]) {
      if (/^\s*select/i.test(query)) return { toArray: () => db.prepare(query).all(...(params as never[])) };
      if (params.length === 0) db.exec(query); else db.prepare(query).run(...(params as never[]));
      return { toArray: () => [] };
    },
  };
  const host: ProjectHost = {
    state: {
      storage: {
        sql,
        setAlarm: async (at: number) => { alarm.at = at; },
        deleteAlarm: async () => { alarm.at = null; },
      },
      getWebSockets: () => [],
    } as never,
    env: env as never,
    running: new Set<string>(),
    architectChatBusy: false,
    architectChatStartedAt: 0,
    chatWindow: [],
    docsCache: null,
    chatStreams: new Set(),
    broadcast: (event) => { broadcasts.push(event); },
    logActivity: (type, detail, ticketId = null) => { activity.push({ type, detail, ticketId }); return `act-${activity.length}`; },
    setActivityMeta: () => {},
  };
  applySchema(sql as never);
  return { host, db, broadcasts, activity, alarm };
}

/** Insert the project row an initialised DO has. */
export function seedProject(db: InstanceType<typeof DatabaseSync>, over: Record<string, unknown> = {}) {
  db.prepare('INSERT INTO project (id, owner_id, name, slug, created_at, cost_cap_monthly_usd) VALUES (?, ?, ?, ?, ?, ?)')
    .run('p1', OWNER, 'Demo', 'demo', Date.now(), 50);
  for (const [col, value] of Object.entries(over)) db.prepare(`UPDATE project SET ${col} = ?`).run(value as never);
}

export function seedTicket(db: InstanceType<typeof DatabaseSync>, id: string, status: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  db.prepare("INSERT INTO tickets (id, seq, title, raw_idea, status, created_at, updated_at) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tickets), 'T', 'idea', ?, ?, ?)")
    .run(id, status, now, now);
  for (const [col, value] of Object.entries(over)) db.prepare(`UPDATE tickets SET ${col} = ? WHERE id = ?`).run(value as never, id);
}

export function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Request {
  return new Request(`http://do${path}`, {
    method: init.method ?? 'GET',
    headers: { 'X-User-Id': OWNER, 'Content-Type': 'application/json', ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}
