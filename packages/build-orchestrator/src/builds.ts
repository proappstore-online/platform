// Build records in D1 (ADR-006 Phase 3). The orchestrator writes one row per
// build and advances its status; the console reads recent rows per app.
//
// SQL is kept thin and the row→JSON mapping pure so the queries are unit-tested
// against a recording mock D1 without a live database.

export type BuildStatus = 'queued' | 'running' | 'success' | 'failed';

export interface BuildRecord {
  id: string;
  appId: string;
  repo: string;
  sha: string;
  status: BuildStatus;
  reason: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
}

/** Map a raw D1 row (snake_case) to the API shape (camelCase). Pure. */
export function rowToBuild(r: Record<string, unknown>): BuildRecord {
  return {
    id: String(r.id),
    appId: String(r.app_id),
    repo: String(r.repo),
    sha: String(r.sha),
    status: r.status as BuildStatus,
    reason: (r.reason as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at == null ? null : Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
  };
}

/** Insert a queued build. id should be the GitHub delivery id (idempotent-ish). */
export async function createBuild(
  db: D1Database,
  b: { id: string; appId: string; repo: string; sha: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO builds (id, app_id, repo, sha, status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'queued', ?5)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(b.id, b.appId, b.repo, b.sha, b.nowMs)
    .run();
}

/** Mark a build as running (container started). */
export async function markRunning(db: D1Database, id: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE builds SET status = 'running', started_at = ?2 WHERE id = ?1`)
    .bind(id, nowMs)
    .run();
}

/**
 * Finish a build. duration_ms is computed from started_at when present (a build
 * that failed before starting has no duration).
 */
export async function finishBuild(
  db: D1Database,
  id: string,
  status: 'success' | 'failed',
  nowMs: number,
  reason?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE builds
         SET status = ?2,
             finished_at = ?3,
             reason = ?4,
             duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ?3 - started_at END
       WHERE id = ?1`,
    )
    .bind(id, status, nowMs, reason ?? null)
    .run();
}

/** Recent builds for an app, newest first. */
export async function listBuilds(db: D1Database, appId: string, limit = 20): Promise<BuildRecord[]> {
  const lim = Math.max(1, Math.min(100, Math.floor(limit)));
  const res = await db
    .prepare(`SELECT * FROM builds WHERE app_id = ?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(appId, lim)
    .all();
  return (res.results ?? []).map((r) => rowToBuild(r as Record<string, unknown>));
}
