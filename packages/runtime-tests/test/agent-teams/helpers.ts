import { env } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';

export const BASE = 'https://agents.test';

export async function session(uid: string, login = uid.replace(/^gh:/, '')): Promise<string> {
  return mintSession({ uid, login, avatarUrl: null, roles: ['user', 'creator'] }, env.SESSION_SIGNING_KEY);
}

export function json(method: string, body?: unknown, token?: string, extra: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/** D1 is shared across tests (isolatedStorage is off); every file clears what it writes. */
export async function resetTables(): Promise<void> {
  for (const t of ['agent_projects', 'team_members']) await env.DB.prepare(`DELETE FROM ${t}`).run();
}

/** A fresh slug per test: Durable Objects are addressed by name and outlive a test. */
export function freshSlug(prefix = 'proj'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
