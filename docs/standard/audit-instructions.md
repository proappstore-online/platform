# Audit instructions

**Standard version 1.5** · Part of the [Application Standard](./index.md) · Machine-readable: [standard.json](./standard.json) · [finding.schema.json](./finding.schema.json) · [full text](./llms-full.txt)

This page is the reusable, tool-agnostic procedure for auditing an application
repository against the standard. It is written to be fetched and followed by an
AI copilot (the audit Agent Skill, issue #172 in `proappstore-online/platform`,
fetches this page and the data file) and to be run by a person the same way.
Nothing here requires credentials: the standard, its data file, and the
schemas are public on `docs.proappstore.online`.

## Inputs

| Input | Where | Why |
|---|---|---|
| The standard as data | `https://docs.proappstore.online/standard/standard.json` (validated by `standard.schema.json`) | The list of clauses, their stable URLs, severities, verification classes and evidence hints |
| The finding contract | `https://docs.proappstore.online/standard/finding.schema.json` | The shape every finding and the report must have |
| The repository | a checkout at a known commit | All configuration, source, process and documentation evidence |
| The deployed app (optional) | `https://<app>.proappstore.online` | Runtime evidence; needed for `runtime` items and for the deploy evidence bundle |

Record `standard.version` and the commit SHA before evaluating anything; both
go into the report and every finding's citation.

## Procedure

1. **Identify the app.** `app_id` is the repository name (and subdomain). Read
   `package.json`, `.github/workflows/`, `mcp.json`, `migrations.json`,
   `web/index.html`, `web/vite.config.ts`, `web/src/lib/app.ts` (or wherever
   `initPro` is called), and `README.md`. Note whether the app is Tailored
   (one fork per customer) or Ready (shared, multi-tenant): it decides the
   tenancy clauses' applicability.
2. **Walk every clause in `standard.json`, chapter by chapter.** For each clause
   decide *applicability* first, from its `applicability` text and what step 1
   found. A clause that does not apply is recorded as `not-applicable` **with the
   evidence that its condition is not met** — never skipped. If applicability
   cannot be determined, the state is `manual-review`.
3. **Gather evidence** using the clause's `evidence` text and the
   [evidence classes](./audit-model.md#evidence-classes): configuration, source,
   process, runtime, documentation. Cite `path:line` for repository evidence and
   a URL plus the observation for runtime evidence. Quote only what is needed and
   never a secret, token, or personal data.
4. **Record one result per clause** using the [result states](./audit-model.md#result-states):
   - `pass` — the evidence shows the clause is met.
   - `fail` — the evidence shows it is not met, **or required evidence for a `MUST` is absent**. Absent evidence is a failure, not a manual review.
   - `not-applicable` — with the reason.
   - `manual-review` — evidence is insufficient, **or the clause's verification class is `human`**. An AI auditor never marks a `human` clause `pass`.
5. **Set severity, confidence and the human-validation flag.** Severity is the
   clause's default unless lowered with a stated reason; it is never raised
   without human validation. Confidence is `high` only when the evidence is
   direct and unambiguous. `human_validation` is `required` when the clause is
   `human`, when confidence is below `high`, or when the remediation would change
   architecture.
6. **Write the finding** for every `fail` (and any `manual-review` worth
   raising) in the shape of `finding.schema.json`: a **title that names the
   defect** in the app's own terms, the exact `clause_url` from `standard.json`,
   the evidence, the impact, a **bounded** remediation (one clause, one app, one
   pull request) specialised from the clause's *Remediation*, and acceptance
   tests taken from the clause's *Tests*.
7. **Compute the deduplication key** as `<app_id>:<clause_id>:<primary evidence path>`,
   where the primary evidence path is `evidence[0].path`. Before opening an
   issue, search the repository's issues for the key (it appears verbatim in the
   issue body); if found, comment on the existing issue instead of opening a new
   one. Two runs on the same commit and standard version must produce the same
   findings and the same keys.
8. **Assemble the report**: the envelope from `finding.schema.json` (standard
   version, app id, repository, commit, date, auditor) plus every clause's
   result — including passes and not-applicables — and, for a deployed app, the
   [deployment evidence bundle](./ops.md#pas-ops-020).

## Rules that override any inference

- **Tests evidence only what they assert.** A green CI, unit or smoke run is
  never evidence for a Security clause or for production state
  ([PAS-OPS-001](./ops.md#pas-ops-001)). Cite a test only under the clause
  whose assertion it implements.
- **Absent `MUST` evidence is a `fail`.** Do not soften it to `manual-review`
  because the file might exist somewhere else; say where you looked.
- **`human` clauses stay `manual-review`** until a person records the result:
  [PAS-AUTH-020](./auth.md#pas-auth-020), [PAS-UI-006](./ui.md#pas-ui-006),
  [PAS-UI-023](./ui.md#pas-ui-023), [PAS-OPS-019](./ops.md#pas-ops-019).
- **Enforcement is not conformity.** A clause whose `enforcement` is `automated`
  is still evaluated; the platform check is one piece of evidence and its
  absence in a run is a finding against the process, not proof of the clause.
- **Never invent architecture.** If a clause cannot be met inside the
  platform's supported patterns, the finding says so, is flagged for human
  validation, and points at a platform issue rather than proposing a substitute
  the standard forbids ([PAS-STACK-024](./stack.md#pas-stack-024)).
- **Do not create issues in read-only mode.** Default to producing the report;
  open issues only when explicitly asked, after the duplicate check.

## Direct audit rules (fast, high-confidence checks)

These greps are the ones the chapters mark as direct rules; a hit is a `fail`
for the clause named unless the clause states an exception.

| Grep | Clause |
|---|---|
| `grep -rn "initPro(" web/src` — no `authMode: 'platform-cookie'` on a hosted app | [PAS-AUTH-001](./auth.md#pas-auth-001) |
| `grep -rn "pas:session\|pas_session\|?session=\|\.auth\.token" web/src` | [PAS-AUTH-002](./auth.md#pas-auth-002), [PAS-AUTH-003](./auth.md#pas-auth-003) |
| `grep -rn "/v1/auth\|/.pas/auth" web/src` | [PAS-AUTH-003](./auth.md#pas-auth-003) |
| `grep -rn "app\.db\.\(query\|execute\|batch\)" web/src` in user paths | [PAS-DATA-003](./data.md#pas-data-003) |
| `grep -rn "dangerouslySetInnerHTML\|innerHTML\|document.write\|eval(\|new Function\|javascript:" web/src` | [PAS-UI-014](./ui.md#pas-ui-014) |
| `grep -n "user-scalable=no\|maximum-scale" web/index.html` | [PAS-UI-007](./ui.md#pas-ui-007) |
| `grep -rn "data-.*proappstore.online\|/.pas/data\|workers.dev\|X-Internal-Token" web/src` | [PAS-DATA-016](./data.md#pas-data-016) |
| every `mcp.json` statement of a `requires_auth: true` tool whose only `:__user_id` use is tautological | [PAS-DATA-007](./data.md#pas-data-007) |

## Issue template

Findings that become issues use this body. The **title is the defect**, not
the clause ID. In `proappstore-online/platform` it is available as the
*Standard finding* issue form (`.github/ISSUE_TEMPLATE/standard-finding.yml`);
app repositories scaffolded from `template-app` will receive the same form in
a follow-up to that repository — until then, copy this body.

````markdown
### Defect
<!-- One sentence naming the defect in the app's terms. This is also the issue title. -->

### Clause
- **Clause:** PAS-XXXX-NNN — <clause title>
- **Clause URL:** https://docs.proappstore.online/standard/<chapter>/#pas-xxxx-nnn
- **Standard version:** 1.5
- **Severity:** critical | high | medium | low | info
- **Verification:** automated | manual | human
- **State:** fail | manual-review

### Applicability
<!-- Why the clause applies to this app. -->

### Evidence
<!-- class · path:line · excerpt / observation. Never paste secrets or personal data. -->
- source · `web/src/lib/app.ts:3` · `initPro({ appId: 'my-app' })` — no authMode

### Impact
<!-- What the failure allows or breaks, in this app's terms. -->

### Remediation (bounded)
<!-- One clause, one app, one PR. -->

### Acceptance tests
- [ ] …

### Confidence and validation
- **Confidence:** high | medium | low
- **Human validation:** required | not-required

### Deduplication key
`<app_id>:<clause_id>:<primary evidence path>`
````

## Example

[`examples/audit.example.json`](./examples/audit.example.json) is a complete,
deterministic report for a fictional app: two failures (legacy session
storage; an unscoped action), one not-applicable clause, one human-only
clause left in `manual-review`. It validates against `finding.schema.json`
and its deduplication keys follow the formula; the platform's test suite
checks both on every commit.
