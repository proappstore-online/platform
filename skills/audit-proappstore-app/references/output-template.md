# Output template — the audit report

The machine-readable report is the envelope plus findings in the shape of
[finding.schema.json](https://docs.proappstore.online/standard/finding.schema.json); the human-readable
summary follows it. A report without the envelope is incomplete.

```markdown
## Audit report: <app_id> @ <commit sha> — standard <version>

### Envelope
| Field | Value |
|---|---|
| standard_version | <from standard.json> |
| app_id / repository | <id> / <org/repo> |
| commit_sha | <sha> |
| audited_at / auditor | <date> / ai: <name> |
| mode | read-only \| issue-creation (threshold: <severity>; exclusions: <clause ids>) |
| category | Tailored \| Ready |

### Results by chapter
| Chapter | pass | fail | not-applicable | manual-review |
|---|---|---|---|---|
| STACK | … | … | … | … |
| AUTH | … | … | … | … |
| DATA | … | … | … | … |
| INT | … | … | … | … |
| UI | … | … | … | … |
| OPS | … | … | … | … |

### Findings
<one per fail, in the app's terms>
- **<defect title>** — <clause id> · <clause URL> · severity <…> · confidence <…> · human validation <…>
  - evidence: <class> · `<path>:<line>` · <excerpt or observation>
  - impact: <…>
  - remediation (bounded): <…>
  - acceptance tests: <from the clause>
  - dedupe key: `<app_id>:<clause_id>:<evidence[0].path>`

### Not-applicable clauses
| Clause | Reason (evidence that the condition is not met) |
|---|---|

### Human-only clauses (manual-review)
- PAS-AUTH-020, PAS-UI-006, PAS-UI-023, PAS-OPS-019 — checklist for a person

### Deployment evidence
<the bundle, or "no deployed app given — runtime items manual-review">

### Issues (issue-creation mode only)
| Finding | Dedupe key | Issue |
|---|---|---|

### Blockers
- <class>: <what is missing and who decides>
```

```json
{
  "$schema": "https://docs.proappstore.online/standard/finding.schema.json",
  "standard_version": "<version>",
  "app_id": "<id>",
  "repository": "<org/repo>",
  "commit_sha": "<sha>",
  "audited_at": "<YYYY-MM-DD>",
  "auditor": { "kind": "ai", "name": "<client>" },
  "findings": [ { "clause_id": "…", "clause_url": "…", "title": "…", "state": "fail", "severity": "…", "verification": "…", "applicability": { "applies": true, "reason": "…" }, "evidence": [ { "class": "source", "path": "…", "line": 0, "excerpt": "…", "observation": "…" } ], "impact": "…", "remediation": "…", "acceptance_tests": [ "…" ], "confidence": "high", "human_validation": "not-required", "dedupe_key": "<app_id>:<clause_id>:<path>" } ]
}
```
