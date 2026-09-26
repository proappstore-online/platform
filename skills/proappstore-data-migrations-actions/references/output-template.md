# Output template — the schema and action plan

```markdown
## Data plan: <app name>

**Category:** <Tailored | Ready> · **Scope unit:** <user | project | org | tenant> · **Standard:** 1.6

### Stores
| Data | Store | Why | Clause |
|---|---|---|---|
| <entity> | D1 via actions / `app.kv` / `app.storage` / `app.counters` / `app.rooms` | <one line> | PAS-DATA-013 |

### Schema (append to `migrations.json`)
```json
{ "name": "000N_<what>", "sql": "CREATE TABLE IF NOT EXISTS <t> (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, …, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_<t>_org ON <t> (org_id, created_at)" }
```
- Owner/tenant column: <…> · Indexes: <…> · Membership table: <…> — PAS-DATA-001

### Actions (`mcp.json`)
| Name | Operation | Params (type, max) | Auth (`requires_auth`, `app_roles`) | Scoping predicate | Invariant / idempotency | Clause |
|---|---|---|---|---|---|---|
| <list_x> | query | limit (integer, max 100), cursor | true, — | `org_id IN (SELECT …)` | `LIMIT :limit`, keyset | PAS-DATA-007, 010 |
| <create_x> | execute | id (string), … | true, — | `:__user_id` as owner | client id + PK | PAS-DATA-006, 018 |
| <close_x> | execute | id | true, ["editor"] | membership sub-query | `AND status = 'open'` | PAS-DATA-008 |
| <create_org> | batch | id, name | true, — | `:__user_id` | one transaction | PAS-DATA-009 |

### Findings (existing app only)
| # | Finding | File | Clause | Remediation |
|---|---|---|---|---|

### Negative tests to add (CI)
- <action> as user B with A's ids → no rows / `meta.changes === 0`
- <action> as `member` → 403
- <create> twice → `meta.changes` 1 then 0
- `q` = `'; DROP TABLE …; --` → empty, table intact

### Migration verification
- [ ] deploy log: `Applied migration(s): ["000N_<what>"]`
- [ ] `schema_status`: latest applied, no failed rows

### Deployment checks
- [ ] *Register app tools* step passes (declared params, no DDL, coherence)
- [ ] `list_app_tools` matches the committed `mcp.json`
- [ ] cross-tenant tests ran in CI on this commit

### Unsupported
| Requirement | Interim pattern | Issue |
|---|---|---|

### Blockers
- <class>: <what is missing and who decides>
```
