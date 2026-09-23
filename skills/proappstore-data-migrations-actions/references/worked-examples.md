# Worked examples

One per evaluation scenario, in the output template's shape.

## new-schema-actions — a task tracker, one user's tasks

Requirements: tasks with status and tags; list, create, close; a theme
preference; nothing shared.

| Need | Decision | Clause |
|---|---|---|
| store | D1 via actions for tasks; `app.kv` for the theme | [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013) |
| schema | `0001_tasks`: `tasks(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER)` + index `(user_id, created_at)` | [PAS-DATA-001](https://docs.proappstore.online/standard/data/#pas-data-001), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| `list_tasks` | `operation: "query"`, `SELECT id, title, status, created_at FROM tasks WHERE user_id = :__user_id AND created_at < :before ORDER BY created_at DESC LIMIT :limit`; `params`: `before` integer, `limit` integer max 100 | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-DATA-010](https://docs.proappstore.online/standard/data/#pas-data-010) |
| `create_task` | `operation: "execute"`, `INSERT OR IGNORE INTO tasks (id, user_id, title, status, created_at) VALUES (:id, :__user_id, :title, 'open', :__now)`; `id` string from the client | [PAS-DATA-006](https://docs.proappstore.online/standard/data/#pas-data-006), [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) |
| `close_task` | `operation: "execute"`, `UPDATE tasks SET status = 'closed', updated_at = :__now WHERE id = :id AND user_id = :__user_id AND status = 'open'`; the UI reads `meta.changes` | [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008) |
| auth | `requires_auth: true` on all three; no roles needed | [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004) |

Tests: `list_tasks` / `close_task` as user B with A's ids → no rows / `meta.changes === 0`; `create_task` twice → 1 then 0. Verification: deploy log lists `0001_tasks`; `schema_status` applied; registration passes. Unsupported: none. Recipe: `crud-list`, `form-create`.

## multi-tenant-scope — a club roster shared by coaches

Requirements: clubs with coaches and players; coaches of a club see and edit
its players; a club is created with its first coach; join by code.

| Need | Decision | Clause |
|---|---|---|
| schema | `clubs`, `club_members(club_id, user_id, role, created_at, UNIQUE(club_id, user_id))`, `players(id, club_id, …)`, `join_codes(id, club_id, role, used_at)`; indexes on `club_id` | [PAS-DATA-001](https://docs.proappstore.online/standard/data/#pas-data-001), [PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011) |
| `list_players` | `… WHERE club_id IN (SELECT club_id FROM club_members WHERE user_id = :__user_id) LIMIT :limit` | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) |
| `update_player` | `… WHERE id = :id AND EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = :__user_id AND m.club_id = players.club_id AND m.role = 'coach')` | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008) |
| `create_club` | batch: insert club (`:id`, `:__user_id`, `:__now`) + insert membership (`:id`, `:__user_id`, `'coach'`) | [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009) |
| `redeem_code` | batch: `INSERT OR IGNORE INTO club_members SELECT jc.club_id, :__user_id, jc.role, :__now FROM join_codes jc WHERE jc.id = :code_id AND jc.used_at IS NULL` + `UPDATE join_codes SET used_at = :__now WHERE id = :code_id AND used_at IS NULL` | [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008) |
| `club_stats` | `SELECT COUNT(*) … WHERE club_id IN (SELECT …)` — scoped, no `caller_unscoped` | [PAS-DATA-012](https://docs.proappstore.online/standard/data/#pas-data-012) |

Tests: every action as a non-member with the club's ids → nothing; `redeem_code` twice → one membership. Unsupported: none. Recipe: `data-table`.

## cross-tenant-access — `update_item` scoped by id only

Finding: `mcp.json` `update_item`: `UPDATE items SET done = :done WHERE id = :id`, `requires_auth: true`. Any signed-in user can flip any item. Clause: [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007). Remediation: `… WHERE id = :id AND org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id AND role IN ('owner','manager'))`. Prove: as user B with A's item id → `meta.changes === 0`. Unsupported: none.

## guessed-identifiers — autoincrement ids on shared rows

Finding: `migrations.json` creates `invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, …)` and `get_invoice` is `SELECT * FROM invoices WHERE id = :id`. Ids are enumerable and the read is unscoped. Clause: [PAS-DATA-001](https://docs.proappstore.online/standard/data/#pas-data-001), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007). Remediation: new table `invoices_v2(id TEXT PRIMARY KEY, …)` filled by an action (expand / contract), inserts from `:__uuid`; `get_invoice` selects named columns `WHERE id = :id AND user_id = :__user_id`. Prove: a known id from another user returns no row. Unsupported: none.

## replayable-grants — role copied from the client, code never consumed

Finding: `join_org` is `INSERT INTO org_members (org_id, user_id, role) VALUES (:org_id, :__user_id, :role)`; `join_codes` rows have no `used_at`. Anyone joins any org as any role, forever. Clause: [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008), [PAS-DATA-006](https://docs.proappstore.online/standard/data/#pas-data-006). Remediation: a batch that inserts `SELECT jc.org_id, :__user_id, jc.role FROM join_codes jc WHERE jc.id = :code_id AND jc.used_at IS NULL` and then sets `used_at = :__now`; migration `0004_join_codes_used_at` adds the column; `role` and `org_id` removed from `params`. Prove: a second redemption creates nothing; a forged `role` param is rejected as undeclared. Unsupported: none.

## unsafe-writes — retry double-inserts, transition without guard

Finding: `create_order` inserts with `:__uuid` and the client retries on timeout; `ship_order` is `UPDATE orders SET status = 'shipped' WHERE id = :id AND user_id = :__user_id`; "create order + reserve stock" is two sequential calls. Clause: [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018), [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008), [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009). Remediation: client-supplied `id` with the primary key and `INSERT OR IGNORE`; `AND status = 'paid'` on the transition; one `operation: "batch"` for order + reservation; the UI reads `meta.changes`. Prove: create twice → 1 then 0; shipping twice → 1 then 0; a failed reservation rolls back the order. Unsupported: none.

## migration-drift — edited entry, action ahead of schema

Finding: `0002_items` was edited after deploy to add `priority`; `list_items` selects `priority`; `schema_status` shows the last attempt failed with "no such column"; the deploy fails at registration. Clause: [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002), [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008). Remediation: restore `0002_items` to its deployed text, append `0003_items_priority` with `ALTER TABLE items ADD COLUMN priority TEXT DEFAULT 'normal'`, redeploy; if the live row is stuck, follow the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/). Prove: deploy log lists `0003_items_priority` under `applied`; `schema_status` applied; registration passes. Unsupported: editing a deployed migration (interim: append).

## raw-browser-sql — `app.db.query` in a component

Finding: `TaskList.tsx` calls `app.db.query('SELECT * FROM tasks WHERE user_id = ?', [user.id])`. Ordinary users get 403 from the data worker; the boundary is the browser. Clause: [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003), [PAS-DATA-016](https://docs.proappstore.online/standard/data/#pas-data-016). Remediation: `list_tasks` action scoped on `:__user_id` with `LIMIT :limit`; call `app.actions.call('list_tasks', { limit: 50 })`; keep `app.db.*` in admin scripts only. Prove: no `app.db.` in user paths; the list loads as an ordinary member. Unsupported: none.

## client-only-authorization — owner check in React only

Finding: `delete_item` is `DELETE FROM items WHERE id = :id` with `requires_auth: true`; the component checks `item.owner === user.id` before calling. Clause: [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016). Remediation: `DELETE FROM items WHERE id = :id AND user_id = :__user_id`; keep the UI check as UX. Prove: calling `delete_item` directly as user B with A's id → `meta.changes === 0`. Unsupported: none.

## injection-surface — sort order from input

Finding: the app builds `ORDER BY ${sort}` and a `LIKE '%${q}%'` string before calling `app.db.query`; a `limit` param has no `max`. Clause: [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005). Remediation: two fixed actions `list_items_by_date` and `list_items_by_name`; `LIKE '%' || :q || '%'` with `q` declared `string`; `limit` integer `max: 100`. Prove: `q` = `'; DROP TABLE items; --` returns nothing and the table remains; `limit: 10000` is clamped. Unsupported: dynamic SQL (interim: one action per variant).
