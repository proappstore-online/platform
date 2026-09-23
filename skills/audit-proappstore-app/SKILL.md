---
name: audit-proappstore-app
description: Audit a ProAppStore app repository against the current public Recommended Application Standard — fetch standard.json and the finding contract, decide applicability clause by clause, inspect code, configuration, tests and (optionally) the deployed app, and emit pass / fail / not-applicable / manual-review findings; every failure carries the standard version, the exact clause URL, file and line evidence, impact, a bounded remediation, acceptance tests, confidence, the human-validation flag and a deduplication key. Read-only by default (a report); creates GitHub issues only in issue-creation mode after a duplicate check, with defect-oriented titles. Use when a user asks to audit, check compliance or conformance of, find findings in, or review clause by clause a ProAppStore app on proappstore.online. Not for fixing the app, creating it, releasing it, or choosing its architecture.
license: MIT
compatibility: Works with any Agent Skills client that can read the app repository and fetch https://docs.proappstore.online. Best with the ProAppStore MCP server (https://mcp.proappstore.online/mcp) for the app's live status, registered actions, migration status, deploy history and QA runs; otherwise repository evidence only. Read-only — no provisioning, no credentials; issue creation only when asked, through the client's own GitHub access.
metadata:
  author: proappstore-online
  version: "1.0"
  mcp-endpoint: https://mcp.proappstore.online/mcp
  standard-version: "1.5"
  issue: proappstore-online/platform#172
  triggers: audit, compliance, conformance, findings, clause by clause, ProAppStore
allowed-tools: whoami app_info list_app_tools schema_status deploy_status qa_list_runs platform_guide
---

# Audit a ProAppStore app against the Recommended Application Standard

You run the published, tool-agnostic audit procedure — the
[audit instructions](https://docs.proappstore.online/standard/audit-instructions/)
— against one app repository at one commit, and produce a report in the shape
of the [finding contract](https://docs.proappstore.online/standard/finding.schema.json).
The standard is fetched, never remembered; findings cite clauses, never
restate them; and a person, not you, closes the human-only clauses.

## When to use / when not to

- **Use** for "audit this app", "is it compliant with the standard?", "what
  fails and why?", "open issues for the findings", and before a release or
  a handover.
- **Do not use** to fix findings (`proappstore-auth-sessions-roles`,
  `proappstore-data-migrations-actions`, `proappstore-upgrade-app`), to ship
  (`proappstore-publish-deploy`), to create an app (`create-proappstore-app`)
  or to choose services (`choose-proappstore-architecture`).

## Rules

1. **The standard is fetched, at its current version.** Read
   [standard.json](https://docs.proappstore.online/standard/standard.json)
   and record its version and the commit SHA before evaluating anything;
   both go into the envelope and every citation. Never audit from memory.
2. **Every clause gets a result.** `pass`, `fail`, `not-applicable` (with
   the evidence that its condition is not met) or `manual-review` — never
   skipped. Absent evidence for a MUST is a `fail`, not a manual review.
3. **Human clauses stay `manual-review`.** [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020),
   [PAS-UI-006](https://docs.proappstore.online/standard/ui/#pas-ui-006),
   [PAS-UI-023](https://docs.proappstore.online/standard/ui/#pas-ui-023) and
   [PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019)
   are never marked `pass` by an AI; green CI, unit or smoke runs are never
   evidence for a Security clause or for production
   ([PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001)).
4. **Findings are complete and bounded.** Every `fail` carries the exact
   clause URL from standard.json, file and line evidence, impact, a
   remediation bounded to one clause, one app, one pull request, acceptance
   tests taken from the clause, confidence, the human-validation flag and
   the deduplication key `<app id>:<clause id>:<primary evidence path>`.
   Never invent architecture the standard forbids
   ([PAS-STACK-024](https://docs.proappstore.online/standard/stack/#pas-stack-024)).
5. **Read-only by default.** The report is the deliverable. Issues are
   opened only in issue-creation mode, after searching the repository's
   issues for the deduplication key, with the defect as the title, in the
   published issue body shape.
6. **Never fabricate surfaces.** Cite only files you read, clauses in
   standard.json, and tool output you received. Quote only what is needed;
   never a secret, a token, or personal data.
7. **Read-only and credential-free.** The MCP allow-list is read-only; agents
   running this skill never handle credentials: no tokens, no `.env`
   contents in evidence, no `wrangler`, no `gh repo create`.

## Workflow

### 1. Fix the inputs

`whoami` for the session; `app_info` for the app id, hostnames and template
provenance; the repository checkout and its commit SHA; standard.json and
its version; the mode (report by default, issue creation only if asked);
severity threshold and exclusions from the user, recorded in the envelope.

### 2. Identify the app

Read `package.json`, the workflows, `mcp.json`, `migrations.json`,
`web/index.html`, `web/vite.config.ts`, the `initPro` call site and the
README. Decide Tailored or Ready — it decides the tenancy clauses'
applicability. `list_app_tools` gives the registered actions as the platform
sees them; `schema_status` the migration state; `deploy_status` and
`qa_list_runs` the deploy and smoke evidence for the OPS chapter.

### 3. Run the direct rules first

[references/direct-rules.md](references/direct-rules.md) lists the greps the
chapters mark as direct, high-confidence checks (legacy session storage,
`app.auth.token` coupling, raw browser SQL, unscoped statements, HTML sinks,
blocked zoom, direct data-worker URLs). A hit is a `fail` for the named
clause unless the clause states an exception; no token value is ever quoted.

### 4. Walk every clause, chapter by chapter

For each clause in standard.json: applicability from its text and step 2;
evidence by class (configuration, source, process, runtime, documentation)
using the [decision tables](references/decision-tables.md); one result;
severity, confidence and human-validation per the rules. Automated
compliance checks are evidence for their facet only
([automation levels](https://docs.proappstore.online/standard/audit-model/)).

### 5. Write the findings

One finding per `fail` (and any `manual-review` worth raising) in the
contract's shape — see [references/output-template.md](references/output-template.md).
Title names the defect in the app's terms. Compute the deduplication key.
Two runs on the same commit and version must produce the same findings.

### 6. Assemble the report

The envelope, every clause's result including passes and not-applicables,
the findings, and — for a deployed app — the deployment evidence bundle
([PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020)).
Apply the severity threshold and exclusions only to what is *raised*, never
to what is *recorded*.

### 7. Issue-creation mode (only when asked)

For each finding at or above the threshold: search the repository's issues
for the deduplication key; comment on a match, otherwise open an issue with
the defect as the title and the published body. Never in read-only mode.

## Reruns and failures

- **Rerun:** an audit is idempotent — the same commit and standard version
  produce the same findings and keys; nothing on the platform changes.
- **Failure:** if standard.json cannot be fetched, stop: there is no
  standard to audit against. If a tool fails, record the affected clauses
  as `manual-review` with the reason and continue with repository evidence.

## Blockers — hand back, do not work around

| Class | Signal | What to say |
|---|---|---|
| **Unsupported requirement** | a clause cannot be met inside the platform's supported patterns | the finding says so, flagged for human validation, pointing at a platform issue — never a substitute |
| **Manual verification** | a `human` clause, or evidence only a person can gather | `manual-review` with the checklist; never `pass` |
| **Credentials** | evidence would require a token, a secret value or `.env` contents | never quote it; cite the path and the observation |
| **Duplicate** | the deduplication key already exists in the issues | comment on the existing issue; do not open another |
| **Verification** | a clause id or URL the user cites is not in standard.json | say so; the fetched standard is the only source |

## Worked examples

[references/worked-examples.md](references/worked-examples.md) covers a
legacy session in storage, a missing SQL tenant guard, a conforming app, a
not-applicable tenancy clause, a human-only clause and issue-creation mode;
[evals/fixtures/](evals/fixtures/) holds the deterministic repository
fixtures and their expected findings, and [evals/cases.json](evals/cases.json)
the machine-checked expectations.
