import { SCHEMA, MIGRATIONS } from './store.ts';

/**
 * Create the project's tables and apply the additive column migrations. Runs
 * once per DO instance (the DO keeps the `initialized` flag); every statement is
 * idempotent, so a cold start over an older DO is safe.
 */
export function applySchema(sql: DurableObjectStorage['sql']): void {
  sql.exec(SCHEMA);
  // Additive column migrations for older DOs (see store.ts MIGRATIONS). Each
  // group is best-effort: if the column already exists the ALTER throws and the
  // group is skipped.
  for (const stmts of MIGRATIONS) {
    try { for (const s of stmts) sql.exec(s); } catch { /* already applied */ }
  }
  // #2 follow-up: autonomous runs no longer hold the owner's session. The
  // column stays (migrations are append-only) but any token captured by an
  // older deploy is purged, so no user credential rests in DO storage.
  try { sql.exec('UPDATE project SET owner_session_token = NULL WHERE owner_session_token IS NOT NULL'); } catch { /* pre-migration DO */ }
}
