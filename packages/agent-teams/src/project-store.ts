/**
 * Pure persistence for a project's working-tree cache (project_files) and durable
 * memory (project_memory). Free functions over SqlStorage — no broadcast/logging
 * — so the storage logic is separable and unit-testable apart from ProjectDO's
 * orchestration. The DO keeps thin wrappers that add the log/broadcast side
 * effects (see rememberFact).
 */
import { uuid } from './store.ts';
import type { MemoryEntry } from './memory.ts';

/** The working-tree cache (GitHub is the source of truth; this mirrors it). */
export function loadFiles(sql: SqlStorage): Map<string, string> {
  const rows = sql.exec('SELECT path, content FROM project_files').toArray() as { path: string; content: string }[];
  return new Map(rows.map((r) => [r.path, r.content]));
}

/** Replace the cached tree wholesale (so deletions are reflected). */
export function saveFiles(sql: SqlStorage, files: Map<string, string>): void {
  const now = Date.now();
  sql.exec('DELETE FROM project_files');
  for (const [path, content] of files) {
    sql.exec('INSERT INTO project_files (path, content, updated_at) VALUES (?, ?, ?)', path, content, now);
  }
}

export function recallMemory(sql: SqlStorage): MemoryEntry[] {
  const rows = sql
    .exec('SELECT id, category, key, value, created_at, updated_at FROM project_memory ORDER BY updated_at DESC')
    .toArray() as { id: string; category: string; key: string; value: string; created_at: number; updated_at: number }[];
  return rows.map((r) => ({ id: r.id, category: r.category, key: r.key, value: r.value, createdAt: r.created_at, updatedAt: r.updated_at }));
}

/**
 * Upsert a memory by key (so a decision is revised, not duplicated). Trims and
 * caps key/value; returns the stored key, or null when the input is empty (the
 * caller decides whether to log/broadcast).
 */
export function upsertMemory(sql: SqlStorage, category: string, key: string, value: string): string | null {
  const k = key.trim().slice(0, 120);
  const v = value.trim().slice(0, 2000);
  if (!k || !v) return null;
  const now = Date.now();
  const existing = sql.exec('SELECT id FROM project_memory WHERE key = ?', k).toArray()[0] as { id: string } | undefined;
  if (existing) {
    sql.exec('UPDATE project_memory SET value = ?, category = ?, updated_at = ? WHERE key = ?', v, category, now, k);
  } else {
    sql.exec(
      'INSERT INTO project_memory (id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      uuid(), category, k, v, now, now,
    );
  }
  return k;
}
