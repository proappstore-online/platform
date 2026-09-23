# Anti-patterns to detect and remediate

Each entry: what to look for (in `migrations.json`, `mcp.json` or the code —
greps the client can run), why it is wrong, the clause, the remediation, and
the test that proves the fix. Findings cite the clause and the file.

## 1. Cross-tenant access

**Detect:** an authenticated statement whose only predicate is `id = :id`, or whose tenant filter is a client param (`org_id = :org_id`) with no membership sub-query; `:__user_id` used tautologically (`OR :__user_id = :__user_id`); reads without any scope. `grep -n '"sql"' mcp.json | grep -v "__user_id"`.
**Why:** any signed-in user can POST any registered action; without a scoping predicate the row id is the only secret.
**Clause:** [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011).
**Remediate:** self-scope (`AND user_id = :__user_id`) or join membership (`AND org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id)`) in every statement, reads included; derive the tenant from the row, not the param.
**Prove:** as user B, call the action with A's ids → no rows (query) or `meta.changes === 0` (execute/batch); repeat for every action.

## 2. Guessed identifiers

**Detect:** `INTEGER PRIMARY KEY AUTOINCREMENT` or sequential ids on rows that are addressed by id from the client; a "share" or "public" feature that relies on the id being unknown.
**Why:** sequential ids are enumerable; an unscoped statement plus a guessable id is a full read of the table.
**Clause:** [PAS-DATA-001](https://docs.proappstore.online/standard/data/#pas-data-001), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007).
**Remediate:** `id TEXT PRIMARY KEY` populated from `:__uuid` (or a client uuid for correlated batch rows); scope the statement anyway — unguessable ids are not authorization.
**Prove:** a scoped statement with a known foreign id still returns nothing for a non-member.

## 3. Replayable grants

**Detect:** a `role`, `org_id` or `is_admin` param copied into an `INSERT`; a join-code or invite redemption whose source row is never consumed (`used_at` / `revoked_at` absent); a guard like "has an accepted invite" that a revoked user can still satisfy.
**Why:** the client names its own privilege, or a one-shot grant stays redeemable forever — a removed manager re-grants themselves.
**Clause:** [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008), [PAS-DATA-006](https://docs.proappstore.online/standard/data/#pas-data-006).
**Remediate:** `INSERT … SELECT :__user_id, jc.role, jc.org_id FROM join_codes jc WHERE jc.id = :code_id AND jc.used_at IS NULL` plus a statement that sets `used_at = :__now` in the same batch; revocation also closes the grant condition.
**Prove:** redeeming the same code twice creates one membership; a revoked member cannot re-redeem.

## 4. Unsafe writes

**Detect:** a state change with no guard on the current state (`UPDATE tasks SET status = 'closed' WHERE id = :id …` without `AND status = 'open'`); an insert whose id comes from `:__uuid` on an action the client may retry; a multi-step flow done as sequential `app.actions.call`s; the UI ignoring `meta.changes`; a bare `SELECT *` list with no `LIMIT`.
**Why:** retries double-insert, stale clients overwrite newer state, half-applied flows are observable, unbounded reads exhaust the worker.
**Clause:** [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018), [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009), [PAS-DATA-010](https://docs.proappstore.online/standard/data/#pas-data-010).
**Remediate:** client-supplied id with a primary key or `UNIQUE` (or `INSERT OR IGNORE`); `AND status = 'open'` guards; `operation: "batch"` for all-or-nothing flows; read `meta.changes`; `LIMIT :limit` with `max` and a keyset cursor.
**Prove:** calling each create/transition twice yields `meta.changes` 1 then 0; a failing second statement rolls back the first.

## 5. Migration or action drift

**Detect:** `schema_status` shows a failed or pending migration; an edited or reordered entry in `migrations.json` (`git log -p migrations.json`); an action referencing a column absent from `migrations.json`; `DROP`, `RENAME`, `DELETE`, `UPDATE` or `NOT NULL` without a default in a migration; `app.db.migrate` in app code; `list_app_tools` listing tools that are not in the committed `mcp.json`.
**Why:** the deploy applies migrations before registering actions and rejects destructive statements; an edited entry never re-applies, so the live schema and the manifest diverge and users hit "no such column".
**Clause:** [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002), [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008).
**Remediate:** append a new additive entry (never edit); expand / contract for renames; move runtime DDL into `migrations.json`; commit `mcp.json` and let the deploy register it; for a failed migration follow the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/).
**Prove:** the deploy log lists the new migration under `applied`; `schema_status` shows it applied; registration passes coherence.

## 6. Raw browser SQL

**Detect:** `grep -rnE "app\.db\.(query|execute|batch|tables|tenant)" src/` in code rendered for ordinary users; SQL strings in the frontend; a `data-<app>.proappstore.online` or `/.pas/data/` URL built in app code.
**Why:** raw SQL is gated by team role — end users get 403 — and it puts the security boundary in the browser.
**Clause:** [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003), [PAS-DATA-016](https://docs.proappstore.online/standard/data/#pas-data-016).
**Remediate:** move every statement into a registered action with declared params and scoping; call it with `app.actions.call`; keep `app.db.*` for admin scripts and local development only.
**Prove:** no `app.db.` call in a user-facing path; every user flow works through actions as an ordinary signed-in user.

## 7. Client-only authorization

**Detect:** a write action with `requires_auth: true` and no scoping predicate, whose "check" lives in the React component (`if (isOwner) await app.actions.call('delete_item', …)`); `requires_auth` missing; `auth.platform_roles` on an ordinary feature; a public tool that selects `*` or has no literal `LIMIT`.
**Why:** the component is under the user's control; the action is reachable without it.
**Clause:** [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-DATA-011](https://docs.proappstore.online/standard/data/#pas-data-011), [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016).
**Remediate:** explicit `requires_auth`, minimal `auth.app_roles`, and the ownership or membership predicate in the SQL; public tools column-explicit with `LIMIT ≤ 500`.
**Prove:** calling the action directly through the SDK as another user changes nothing (`meta.changes === 0`); a `member`-only account gets 403 on role-gated actions.

## 8. Injection surface

**Detect:** SQL assembled in code from input (`ORDER BY ${sort}`, a table name param, a `LIKE` pattern built by string concatenation); an undeclared `:param`; a `limit` param without `max`.
**Why:** the manifest's fixed SQL is what makes actions safe; anything assembled at runtime is an injection path, and registration rejects undeclared params anyway.
**Clause:** [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005).
**Remediate:** one fixed statement per variant (`list_items_by_date`, `list_items_by_name`); `LIKE '%' || :q || '%'` with `:q` declared; every integer limit with `max`.
**Prove:** a `q` of `'; DROP TABLE tasks; --` returns nothing and the table still exists; a `limit` above `max` is clamped.
