# Output template — dry-run report and stage record

## Dry-run report

```markdown
## Upgrade report: <app> — dry run, nothing changed

**Hostnames:** <…> · **Template:** <template_id @ template_rev | unknown> · **Standard:** 1.5 · **Date:** <date>

### Inventory
| Area | Current | Baseline | Drift | Clause |
|---|---|---|---|---|
| Node / pnpm | <engines, packageManager> | node >=22, pnpm 10.x | <none | behind | missing> | PAS-STACK-001 |
| SDK / CLI | <ranges> | sdk >=1.16.0, cli >=2.6.0 | <…> | PAS-STACK-002 |
| deploy.yml | <canonical | diverged: …> | canonical | <…> | PAS-STACK-005 |
| ci.yml / compliance.yml | <…> | template gates | <…> | PAS-OPS-004 |
| Secrets | <gh secret list> | none | <…> | PAS-OPS-006 |
| Session mode | <authMode> | platform-cookie | <…> | PAS-AUTH-001 |
| Schema | <migrations.json | runtime migrate> ; schema_status <…> | additive, deploy-applied | <…> | PAS-DATA-002 |
| Actions | <n in mcp.json, n registered; requires_auth explicit?> | explicit, scoped | <…> | PAS-DATA-003 / 004 |
| Theme / viewport / SW | <key, meta, plugin settings> | stores-theme, zoomable, autoUpdate + denylist | <…> | PAS-UI-002 / 007 / 018 |
| Tests | <typecheck, unit, negative, smoke> | all four | <…> | PAS-OPS-001 / 002 / 010 |

### Customisations preserved (product-owned files that differ from the template)
- <file>: <what it does> — untouched by every stage except <n> (minimal diff, review required)

### Staged plan
| # | Stage | Files | Preserves | Proof | Rollback | Review | Human |
|---|---|---|---|---|---|---|---|
| 1 | Toolchain | … | … | … | revert | no | no |
| 4 | Platform-cookie | `initPro` options; <files with storage code> | auth UI | usesPlatformCookie, no storage session | revert | **yes** | **sign-in per hostname** |

### Risks and unsupported
| Item | Interim pattern | Clause |
|---|---|---|

Next: pick a stage number to implement (bounded mode).
```

## Stage record (bounded implementation)

```markdown
## Upgrade stage <n> — <name>: <app> @ <sha>

**Files changed:** <list, each marked template-owned | product-owned (diff shown, approved)>
**Preserved:** <…>

### Gates
| Gate | Result |
|---|---|
| pnpm install --frozen-lockfile | ok |
| pnpm typecheck | ok |
| pnpm test | ok |
| pas check | ok |

### Release
Handed to `proappstore-publish-deploy`: deploy run <URL>, smoke <run id: passed>, schema_status <…>, discover_tools <unchanged | updated>.

### Human checks pending
- [ ] <e.g. sign in on <hostname> — PAS-AUTH-020>

### Rollback
`git revert <sha>` → release → smoke. Independent of the other stages.
```
