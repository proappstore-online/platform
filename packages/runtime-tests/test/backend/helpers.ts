import { env, fetchMock } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';

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

/** Outbound fetch from this worker is mocked; nothing reaches the network. */
export function mockNetwork(): void {
  fetchMock.activate();
  fetchMock.disableNetConnect();
}
