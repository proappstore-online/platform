# Unsupported requirements — say so, give the interim pattern, cite the clause

A requirement here has **no platform primitive today**, or is forbidden by
the standard. Recommend the interim pattern; never an own Worker, an external
database or a client-side workaround.

| Requirement | Status | Interim pattern that conforms | Cite |
|---|---|---|---|
| Logic that is not bounded SQL (a rules engine, verifying a claim, calling an API inside a transaction) | no app-code execution surface | record the client's result as a claim and confirm it through a privileged action; express invariants in SQL | [PAS-DATA-014](https://docs.proappstore.online/standard/data/#pas-data-014); platform issue #148 |
| Scheduled or background execution (reapers, digests, nightly recomputes) | supported for bounded registered actions | an idempotent, `LIMIT`-bounded `execute` / `batch` with fixed `schedule` params, authenticated unscoped reason and a ≥5-minute UTC cron; inspect `list_scheduled_runs` | [PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019); platform issue #123 |
| Destructive migrations (`DROP`, `RENAME`, `DELETE`, `UPDATE`, `NOT NULL` without a default) | rejected by the deploy | expand / contract: add, migrate through an action, stop reading; drop nothing | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| Editing a migration that already deployed | never re-applies | append a new named additive entry that corrects it | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| More than 25 statements in one transaction, or more than 120 actions | platform caps | split the flow into independently idempotent batches; consolidate variants | [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009) |
| Dynamic SQL (client-chosen columns, tables, sort orders) | forbidden | one fixed action per variant; declared params only | [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005) |
| Raw SQL from the browser for end users | forbidden — team-role gated | registered actions | [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003) |
| Reading another app's data, or sharing a D1 between apps | one D1 per app | the other app's registered actions over MCP, called with the caller's own session | [PAS-DATA-016](https://docs.proappstore.online/standard/data/#pas-data-016) |
| An external database or BaaS | forbidden | D1 via `migrations.json` and actions | [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007), [PAS-STACK-024](https://docs.proappstore.online/standard/stack/#pas-stack-024) |
| Row-level security or policies as a database feature | not offered | the scoping predicate in every statement; membership tables | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) |
| Point-in-time restore or self-service backups | none app-facing | export/import actions, soft deletes, a written recovery path | [PAS-OPS-014](https://docs.proappstore.online/standard/ops/#pas-ops-014) |
| Offline writes queued for replay | no sync engine | only for idempotent actions, with the user told the write is pending | [PAS-UI-019](https://docs.proappstore.online/standard/ui/#pas-ui-019), [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) |
| Full-text search, vector search, or triggers in D1 | not offered through actions | `LIKE` on a declared `:q` with a bounded `LIMIT`; embeddings through `app.ai` with ids stored in D1 | [PAS-DATA-012](https://docs.proappstore.online/standard/data/#pas-data-012), [PAS-STACK-016](https://docs.proappstore.online/standard/stack/#pas-stack-016) |

When a gap is decisive for the product, say so and stop: it is a
**blocker: unsupported requirement**, not a reason to design around the
standard.
