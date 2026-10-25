import type { ProjectHost } from './project-host.ts';
import { json } from './store.ts';
import { recallMemory, upsertMemory } from './project-store.ts';

export function rememberFact(h: ProjectHost, category: string, key: string, value: string): void {
  const k = upsertMemory(h.state.storage.sql, category, key, value);
  if (!k) return;
  h.logActivity('memory', `Remembered: ${k}`);
  h.broadcast({ type: 'memory-updated' });
}

export async function addMemory(h: ProjectHost, request: Request): Promise<Response> {
  const body = (await request.json()) as { category?: string; key?: string; value?: string };
  if (!body.key?.trim() || !body.value?.trim()) return json({ error: 'key and value required' }, 400);
  rememberFact(h, body.category ?? 'decision', body.key, body.value);
  return json({ memory: recallMemory(h.state.storage.sql) });
}

export function forgetMemory(h: ProjectHost, id: string): Response {
  const row = h.state.storage.sql.exec('SELECT key FROM project_memory WHERE id = ?', id).toArray()[0] as { key: string } | undefined;
  h.state.storage.sql.exec('DELETE FROM project_memory WHERE id = ?', id);
  if (row) h.logActivity('memory', `Forgot: ${row.key}`);
  h.broadcast({ type: 'memory-updated' });
  return json({ ok: true });
}
