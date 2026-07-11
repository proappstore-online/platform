# Migration Repair Runbook

PAS app schema is deployed from each app repo's committed `migrations.json`.
Deploys apply migrations before uploading frontend code and before registering
`mcp.json` actions. Failures are recorded in `migration_audit`.

## Detect

Check one app:

```bash
curl -H "Authorization: Bearer $PAS_SESSION" \
  https://api.proappstore.online/v1/apps/<app-id>/schema-status
```

Check the fleet as a platform admin:

```bash
curl -H "Authorization: Bearer $PAS_ADMIN_SESSION" \
  https://api.proappstore.online/v1/migrations/reconcile
```

The hourly `Reconcile app migrations` GitHub Actions workflow calls the same
endpoint with `X-Internal-Token`, uploads `migration-reconcile.json`, and fails
the run when any app's latest migration attempt is `failed`. `no_history` apps
are reported as warnings because they may be old apps or apps without
`migrations.json`.

The fleet report returns:

- `failed` — latest migration attempt failed; repair is actionable.
- `no_history` — no deploy-time migration attempt recorded yet; verify whether
  the app has a `migrations.json` before treating it as drift.
- `ok` — included only with `?includeOk=true`.

## Interpret

For a failed app, inspect `detail`. Data-worker statement failures include:

- `migration` — migration name from `migrations.json`.
- `statementIndex` — zero-based statement number inside that migration.
- `statement` — the statement that failed, truncated for logs.
- `applied` — earlier migrations completed in this same attempt.
- `already` — migrations already present in `_migrations` before this attempt.

The data worker records a migration in `_migrations` only after every statement
in that migration succeeds. A mid-migration DDL failure may still leave earlier
statements from the same migration applied, because D1 DDL is not reliably
transactional. Do not mark the migration applied by hand.

## Repair

Default to forward-fix:

1. Fix the app repo by adding a new additive migration. Do not edit an already
   applied migration.
2. Keep repair SQL idempotent: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF
   NOT EXISTS`, nullable/defaulted `ALTER TABLE ... ADD COLUMN`, or guarded
   `INSERT`.
3. Push to `main`; the deploy workflow reruns migrations before code/action
   registration.
4. Recheck `/v1/apps/<app-id>/schema-status`. The latest attempt should be
   `applied`, which clears the unresolved-failure signal.

Use the internal repair path only when the app repo cannot deploy:

```bash
curl -X POST \
  -H "X-Internal-Token: $INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.proappstore.online/v1/apps/<app-id>/migrate/internal \
  --data-binary @repair-migrations.json
```

`repair-migrations.json` uses the normal shape:

```json
{
  "migrations": [
    {
      "name": "0007_repair_missing_column",
      "sql": "ALTER TABLE items ADD COLUMN priority TEXT DEFAULT 'normal'"
    }
  ]
}
```

The platform applies the same additive-only lint to repair migrations. Destructive
changes, renames, deletes, updates, and `ADD COLUMN ... NOT NULL` without a
non-null default are rejected.

## Do Not

- Do not run manual `wrangler d1 execute --remote` as the first repair move.
- Do not insert into `_migrations` manually.
- Do not edit old migration names or SQL in app repos.
- Do not contract schema in the same release as dependent code.
