import { env, fetchMock } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';
import { vi } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { APP_EVENT_MAX_RETRIES, APP_EVENTS_DLQ, APP_EVENTS_QUEUE, type AppEventMessage } from '../../../backend/src/lib/app-event-queue';
import { handleAppEventBatch } from '../../../backend/src/lib/app-event-consumer';

export const BASE = 'https://api.test';

export async function session(uid: string, opts: { login?: string; roles?: string[] } = {}): Promise<string> {
  return mintSession({ uid, login: opts.login ?? uid.replace(/^gh:/, ''), avatarUrl: null, roles: opts.roles ?? ['user', 'creator'] }, env.SESSION_SIGNING_KEY);
}

export async function seedUser(uid: string, login = uid.replace(/^gh:/, '')): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, provider, provider_id, login, avatar_url, created_at, last_login_at) VALUES (?1, 'github', ?2, ?3, NULL, ?4, ?4)",
  ).bind(uid, uid.replace(/^gh:/, ''), login, Date.now()).run();
}

/** An app row owned by `creator`. Only the columns every migration guarantees. */
export async function seedApp(id: string, creator: string): Promise<void> {
  const cols = await env.DB.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>();
  const required = (cols.results ?? []).filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  const names = ['id', 'creator_id', ...required];
  const values = [id, creator, ...required.map((c) => (/_at$/.test(c) ? Date.now() : `${id}-${c}`))];
  await env.DB.prepare(`INSERT OR IGNORE INTO apps (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();
}

export function json(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/** Storage is shared across tests (see vitest.backend.ts); every file empties what it writes. */
export async function resetTables(): Promise<void> {
  for (const t of ['app_logs', 'app_log_usage', 'app_roles', 'app_tools', 'app_endpoint_audit', 'user_app_tokens', 'team_members', 'apps', 'users']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

/**
 * A request as the host worker sends it (#315): through its service binding to the
 * backend's HostApi entrypoint, the only path that keeps X-PAS-App / X-PAS-Host.
 * SELF.fetch is a direct caller; its copies of those headers are stripped.
 */
export function viaHostApi(url: string, init?: RequestInit): Promise<Response> {
  return (env as unknown as { HOST_API: Fetcher }).HOST_API.fetch(url, init);
}

/** Outbound fetch from this worker is mocked; nothing reaches the network. */
export function mockNetwork(): void {
  fetchMock.activate();
  fetchMock.disableNetConnect();
}

/** Record what the backend puts on the app-events queue (#257) instead of sending it; undo with vi.restoreAllMocks(). */
export function captureAppEvents(): AppEventMessage[] {
  const sent: AppEventMessage[] = [];
  vi.spyOn(env.APP_EVENTS!, 'send').mockImplementation((async (m: AppEventMessage) => { sent.push(m); }) as never);
  return sent;
}

/** One consumer invocation for one message, as Queues would make it: `attempts` counts from 1. */
export async function consumeAppEvent(m: AppEventMessage, attempts: number, queue = APP_EVENTS_QUEUE): Promise<{ acked: boolean; retryDelay: number | null }> {
  const out = { acked: false, retryDelay: null as number | null };
  const message = { id: m.id, timestamp: new Date(), body: m, attempts, ack: () => { out.acked = true; }, retry: (o?: { delaySeconds?: number }) => { out.retryDelay = o?.delaySeconds ?? 0; } };
  await handleAppEventBatch({ queue, messages: [message], ackAll() {}, retryAll() {} } as unknown as MessageBatch<AppEventMessage>, env as unknown as Env);
  return out;
}

/** Run recorded messages to completion like Queues: retry until acked, then dead-letter after max_retries. Returns each message's tries. */
export async function drainAppEvents(sent: AppEventMessage[]): Promise<{ id: string; tries: number; deadLettered: boolean }[]> {
  const done: { id: string; tries: number; deadLettered: boolean }[] = [];
  while (sent.length) {
    const m = sent.shift()!;
    let tries = 0;
    for (;;) {
      tries += 1;
      if ((await consumeAppEvent(m, tries)).acked) { done.push({ id: m.id, tries, deadLettered: false }); break; }
      if (tries > APP_EVENT_MAX_RETRIES) {
        await consumeAppEvent(m, 1, APP_EVENTS_DLQ);
        done.push({ id: m.id, tries, deadLettered: true });
        break;
      }
    }
  }
  return done;
}
