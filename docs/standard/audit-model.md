# Audit model

**Standard version 1.2** · Part of the [Application Standard](./index.md)

This page defines the vocabulary an audit uses: how applicability is decided,
what counts as evidence, how a clause is verified, how results and severities
are recorded, and what a finding must contain. Every chapter and every clause
uses these definitions unchanged.

## Applicability

Each clause states *Applicability*: the condition under which it applies to an
app. Conditions are written in terms of observable facts about the repository
or the app's declared capabilities, for example "apps that store per-user
rows in D1" or "apps that call third-party APIs".

- A clause with applicability **All apps** applies to every audited app.
- A clause whose condition is not met is recorded as **not-applicable**, with
  the reason. "Not applicable" is a result, not a skip: the auditor must
  cite the evidence that the condition is not met (for example
  "`mcp.json` declares no `execute` or `batch` tools").
- If the condition cannot be determined from the evidence available, the
  result is **manual-review**, not not-applicable.

## Evidence classes

Every clause lists the evidence to inspect, classified as one of:

| Class | What it is | Examples |
|---|---|---|
| **Configuration** | Declarative files that shape the app | `wrangler.toml`, `mcp.json`, `migrations.json`, `package.json`, `.pas.json` |
| **Source** | Application code | `web/src/**`, `initPro()` options, SDK calls, SQL in registered actions |
| **Process** | How the app is built, tested and shipped | `.github/workflows/*`, test files, lockfile |
| **Runtime** | Observable behaviour of the deployed app | response headers, sign-in flow, `GET /v1/apps/<id>/tools` output |
| **Documentation** | What the app says about itself | `README.md`, privacy notes, changelog |

Evidence is cited as `path:line` for Configuration, Source and Process, as a
URL plus what was observed for Runtime, and as a path for Documentation.

## Verification classes

Each clause is verified in exactly one of three ways:

| Class | Who performs it | Result it can produce |
|---|---|---|
| **Automated** | A platform or compliance check, named in the clause's *Enforcement* line | `pass` / `fail` |
| **Manual** | An AI copilot or a human reading the evidence against the clause | `pass` / `fail` / `not-applicable` / `manual-review` |
| **Human** | A person with product or security context; the AI can gather evidence but must not decide | `manual-review` until a person records the result |

A clause verified *Automated* may still be audited manually; the automated
result is authoritative when the two disagree, and the disagreement is itself
a finding against the check.

## Result states

| State | Meaning |
|---|---|
| `pass` | The evidence shows the clause is met. |
| `fail` | The evidence shows the clause is not met, or required evidence is absent. Absent evidence for a `MUST` is a failure, not a manual review. |
| `not-applicable` | The clause's applicability condition is not met; the reason is recorded. |
| `manual-review` | The evidence is insufficient to decide, or the clause is *Human*-verified. |

A `SHOULD` clause that is not met records `fail` at the clause's stated
severity; a documented, reasoned deviation is recorded in the finding and
flagged for human validation. A `MAY` clause never fails: if the capability is
not used, the result is `not-applicable`.

## Severity levels

Severity describes the impact of a failure, not how hard it is to fix. Each
clause declares its default severity; an auditor may lower it with a stated
reason but must not raise it above the clause's default without human
validation.

| Level | Impact when the clause fails |
|---|---|
| **Critical** | Cross-tenant data exposure, credential leakage, or unauthenticated write access. Fix before the next deploy. |
| **High** | Bypass of a platform security boundary (session, RBAC, action scoping) or loss of user data. |
| **Medium** | Unsupported substitute for a platform primitive; degraded reliability, privacy, or operability. |
| **Low** | Quality, consistency, or maintainability gap with no security or data impact. |
| **Info** | Observation only; no action required. Used for `MAY` capabilities the app could adopt. |

## Findings

A finding is the record of one `fail` (or one `manual-review` worth raising).
One finding becomes one issue. Every finding carries:

| Field | Content |
|---|---|
| **Title** | Describes the defect, not the clause. "Session token stored in localStorage" rather than "PAS-AUTH-001 failed". |
| **Standard version** | The version audited against, for example `1.0`. |
| **Clause URL** | The exact public clause URL, including the clause anchor. |
| **Evidence** | `path:line` references or runtime observations, per the evidence classes above. |
| **Impact** | What the failure allows or breaks, in the app's own terms. |
| **Remediation** | A bounded change — one clause, one app, one PR's worth of work. Taken from the clause's *Remediation*, specialised to the evidence. |
| **Acceptance tests** | How the fix is proven, taken from the clause's *Tests*. |
| **Confidence** | `high` / `medium` / `low` — the auditor's confidence in the `fail` result. |
| **Human validation** | `required` when the verification class is *Human*, when confidence is below `high`, or when the remediation would change architecture. |
| **Deduplication key** | `<app id>:<clause id>:<primary evidence path>`, so a re-run does not open a second issue for the same defect. |

The machine-readable form of this contract, and the issue template an AI
should emit, are published alongside the standard as they land; this page is
the normative definition either way.

## Audit report

An audit report lists every clause in every chapter with its result state, the
evidence considered, and — for `not-applicable` — the reason. Clauses marked
*Withdrawn* in the [governance page](./governance.md#withdrawals) are listed
with the result `not-applicable` and the reason "withdrawn in <version>".
