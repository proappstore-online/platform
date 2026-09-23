---
name: proappstore-data-migrations-actions
description: Design and implement a ProAppStore app's data layer — choose D1 versus KV, storage, counters or rooms, write additive migrations in migrations.json, define registered actions in mcp.json with declared typed parameters and the server-owned magic parameters, scope every statement to the caller, project or tenant in SQL, put write invariants and server-derived grants in the statement, use atomic batch actions, keep writes idempotent, and produce negative authorization tests, migration verification and deployment checks. Reviews schemas and manifests for cross-tenant access, guessed identifiers, replayable grants, unsafe writes and migration or action drift, citing the Application Standard's DATA clauses. Use when a user asks how to model tables, write a migration, add or fix a registered action, scope queries to a tenant, make a write safe under retry, or review the data access of an app on proappstore.online. Not for creating an app, overall architecture, authentication, or a full audit.
license: MIT
compatibility: Works with any Agent Skills client. Best with the ProAppStore MCP server (https://mcp.proappstore.online/mcp) to verify SDK surfaces and read an existing app's registered actions and migration status; otherwise uses the public docs only. Read-only advisory skill — no provisioning, no credentials, no raw SQL execution.
metadata:
  author: proappstore-online
  version: "1.0"
  mcp-endpoint: https://mcp.proappstore.online/mcp
  standard-version: "1.5"
  issue: proappstore-online/platform#175
  triggers: migrations, migration, registered actions, registered action, tenant, data access, ProAppStore
allowed-tools: whoami sdk_reference recipe platform_guide app_info discover_tools schema_status
---

# Design migrations, registered actions and tenant-safe data access

You design or correct a ProAppStore app's data layer so that it conforms to
the [DATA chapter](https://docs.proappstore.online/standard/data/) of the
Recommended Application Standard: schema in `migrations.json` and applied by
the deploy, every user-facing read and write a registered action in
`mcp.json`, every statement scoped in SQL, invariants and grants inside the
statement, atomic batches, idempotent writes, and tests that prove it. You
plan and prescribe; you never run SQL, provision or deploy.

## When to use / when not to

- **Use** for "which store for X?", "how do I add a table / column?", "write
  the action for …", "how do I scope this to the org?", "is this safe under
  retry?", and for reviewing an existing `migrations.json` + `mcp.json` for the
  findings in [references/anti-patterns.md](references/anti-patterns.md).
- **Do not use** to create the app (`create-proappstore-app`), for the
  overall service choice beyond data (`choose-proappstore-architecture`), for
  identity and roles (`proappstore-auth-sessions-roles`), or for a whole-
  standard audit.

## Rules

1. **Registered actions are the only user-facing data path.** Raw
   `app.db.query` / `execute` / `batch` are team tools; they never appear in
   code an ordinary user runs, and the browser never holds SQL
   ([PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003),
   [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007)).
2. **The SQL is the security boundary.** Every statement of an authenticated
   action — reads included — scopes rows with `:__user_id` directly or through
   a membership sub-query; manifest roles are an early gate, never the whole
   model, and a client-side check is never authorization
   ([PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007),
   [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004)).
3. **The server owns identity, time and ids.** Actions take `:__user_id`,
   `:__now` and `:__uuid` from the executor; they never accept a caller id,
   timestamp, role or grant as a parameter, and privileges are derived from a
   server row inside the statement
   ([PAS-DATA-006](https://docs.proappstore.online/standard/data/#pas-data-006),
   [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008)).
4. **Inputs are declared, typed and bounded; SQL text is fixed.** Every
   `:param` is a `params` entry with a type, limits carry `max`, and no table,
   column, sort order or `LIKE` pattern is assembled from input
   ([PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005)).
5. **Schema is additive and deploy-applied.** `migrations.json` entries are
   appended with a new name, never edited, contain only additive statements,
   and are applied by the deploy before the actions register
   ([PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002),
   [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008)).
6. **Never fabricate APIs.** Name only `app.actions.call` / `callPublic`, the
   manifest keys in the [decision tables](references/decision-tables.md),
   and surfaces you confirmed with `sdk_reference` (feature `db`, `tenant`,
   `kv`, `storage`, `counters`, `rooms`) or `recipe`. No surface → say so.
7. **Read-only and credential-free.** Agents running this skill
   never handle credentials: no tokens, no `.env`, no `wrangler`, no
   `gh repo create`, and no SQL executed against a live database. Output is a
   plan and code the user commits; the deploy applies it.

## Workflow

### 1. Establish the context

Ask for or read: the entities and who shares them (one user, a project, an
organisation, a tenant — Tailored or Ready); which flows write, which read,
which must be atomic; volumes and list sizes; what must be public. For an
**existing** app: `app_info` (hostnames, template), `discover_tools` (its
registered actions and which require auth), `schema_status` (whether the
latest migration applied or failed). If the client can read the repository,
read `migrations.json` and `mcp.json` and run the checks in
[references/anti-patterns.md](references/anti-patterns.md).

### 2. Choose the store and shape the schema

Walk the *stores* and *schema* tables in
[references/decision-tables.md](references/decision-tables.md): D1 via
actions for relational or shared records, `app.kv` for one user's small
state, `app.storage` for files, `app.counters` for tallies, `app.rooms` for
ephemeral fan-out. For each table: text id from `:__uuid`, a created-at timestamp in
milliseconds from `:__now`, an owner or tenant column, indexes on filter columns, a membership
table when rows are shared.

### 3. Define the actions

For each flow, one manifest entry: name, `operation` (`query`, `execute`,
`batch`), fixed SQL, declared `params` with types and `max`, explicit
`requires_auth`, minimal `app_roles`, and the scoping predicate. Multi-step
flows are one `batch`; creates take a client-supplied id under a unique
constraint or use `INSERT OR IGNORE`; transitions guard on current state;
lists carry `LIMIT` and a keyset cursor; public queries are column-explicit
with a literal `LIMIT`. Background work is an idempotent, bounded, privileged
action ([PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019)).

### 4. Detect and remediate anti-patterns

For each hit in [references/anti-patterns.md](references/anti-patterns.md)
— cross-tenant access, guessed identifiers, replayable grants, unsafe
writes, migration or action drift, raw browser SQL, client-only
authorization — give the finding, the clause, the exact remediation and the
test that proves it. Unsupported asks go to
[references/unsupported-requirements.md](references/unsupported-requirements.md)
with the interim pattern.

### 5. Verify surfaces

`sdk_reference` (feature `db`) for `app.actions.call` and `callPublic` and
the result shape; `sdk_reference` (feature `tenant`) for the team-only tenant
helpers; `recipe` (`crud-list`, `form-create`, `data-table`, `search-filter`)
for UI patterns. If the user names a manifest key or method the reference
does not show, say it does not exist.

### 6. Produce the plan

Render [references/output-template.md](references/output-template.md): the
store decision, the schema with its migration entry, the action table with
scoping predicate and clause per action, the negative tests to add, the
migration verification (deploy log, `schema_status`) and the deployment
checks (registration passes, coherence, drift). One screen; details in the
tables.

### 7. Hand off

- Identity, roles and the permissions UI → `proappstore-auth-sessions-roles`.
- Failed or pending migrations → the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/), run by the team.
- Deploy and registration mechanics → [app actions security](https://docs.proappstore.online/app-actions-security/).

## Blockers — hand back, do not work around

| Class | Signal | What to say |
|---|---|---|
| **Unsupported requirement** | logic that is not bounded SQL, cron, an own Worker, cross-app data, destructive migrations | the interim pattern and the clause; the tracking issue (#123, #148) |
| **Product decision** | the tenancy model or who may see whose rows is undecided | ask; do not invent a scoping rule |
| **Verification** | `sdk_reference` or the manifest reference lacks the key or method the user wants | say it does not exist; recommend the real one |
| **Live schema** | `schema_status` shows a failed migration | stop designing on top of it; point at the runbook |

## Reruns and failures

- **Rerun:** the plan is idempotent — the same schema, manifest and
  requirements produce the same plan; nothing on the platform changes
  between runs. Rerun after each edit to confirm a finding is gone.
- **Failure:** if `schema_status` or `discover_tools` fails, keep the
  static findings, mark the live checks *unverified*, and stop rather than
  design on an unknown schema.

## Worked examples

[references/worked-examples.md](references/worked-examples.md) covers a
new schema and its actions, a multi-tenant scope, and one remediation per
anti-pattern; [evals/cases.json](evals/cases.json) holds the machine-checked
expectations for the same scenarios.
