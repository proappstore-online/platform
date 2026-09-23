# Output template — release preview and release report

## Before the push: release preview

```markdown
## Release preview: <app> @ <short sha>

**Policy:** <direct-to-main | pull request> · **Previous deploy:** <run URL, sha, success> · **Schema status:** <applied / none pending>

### Gates
| Gate | Result |
|---|---|
| pnpm install --frozen-lockfile | ok |
| pnpm typecheck | ok |
| pnpm test | ok (<n> tests) |
| pas check | ok |

### What this push applies
| Change | Detail | Consequential? | Rollback |
|---|---|---|---|
| migration | <000N_name>: <statement> | yes — additive, stays after a revert | forward fix only |
| action added / changed / removed | <name>: <what> | <yes if removed or auth changed> | revert restores the manifest |
| workflow / dependencies | <…> | <…> | revert |

Go-ahead required before pushing.
```

## After the deploy: release report

```markdown
## Release report: <app> @ <short sha>

**Result:** <verified | failed — rolled back to <sha> | failed — stopped at <step>>

### Evidence bundle
| Item | Value |
|---|---|
| Commit / CI run | <sha> — <ci run URL> |
| Deploy run | <run URL> |
| Migrations | `Applied migration(s): […]` / `already: […]` |
| Registration | `Registered N app tool(s)` |
| Upload | `Deployed apps/<app> from <sha>` |
| Smoke / QA | run <id>: <passed, steps n/n> |
| schema_status | latest applied, no failed rows |
| pas check | ok |
| Repository secrets | <none | e2e fixture only> |
| Served build | <sha from a fresh log entry> |

### Verification
- [x] registered actions match the committed mcp.json (`discover_tools`)
- [x] smoke passed for this SHA
- [x] served build equals the pushed SHA
- [ ] **pending (human):** sign-in per provider and hostname; custom domains; operational checklist — PAS-OPS-019 / PAS-AUTH-020

### Failures and recovery
| Step | What happened | Action taken |
|---|---|---|

### Rollback path
`git revert <sha>` → push → deploy run → smoke; schema additive, no migration to undo.

### Blockers
- <class>: <what is missing and who decides>
```
