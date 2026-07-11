-- Audit trail for deploy-time D1 migrations (routes/deploy.ts applyMigrations, #33).
-- One row per migrate attempt: the outcome (applied/failed), which migration
-- names ran vs were already applied, and any failure detail. This is what makes
-- pending/failed migrations VISIBLE (console schema-status + "who migrated app X,
-- when, and did it succeed") instead of a migration silently never applying.

CREATE TABLE IF NOT EXISTS migration_audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id    TEXT    NOT NULL,
  source    TEXT    NOT NULL,   -- 'oidc' (workflow) | 'internal' (agent deploy stage)
  status    TEXT    NOT NULL,   -- 'applied' | 'failed'
  applied   TEXT,               -- JSON array of newly-applied migration names
  already   TEXT,               -- JSON array of names that were already applied
  detail    TEXT,               -- error detail when status = 'failed'
  ran_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_migration_audit_app ON migration_audit (app_id, ran_at DESC);
