# Audit model

**Standard version 1.6** · Part of the [Application Standard](./index.md)

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

The machine-readable form of this contract is
[`finding.schema.json`](./finding.schema.json) (with a worked example in
[`examples/audit.example.json`](./examples/audit.example.json)); the procedure
that produces findings is the [audit instructions](./audit-instructions.md),
and the clauses themselves are available as [`standard.json`](./standard.json).
This page is the normative definition either way.

## Automation levels

Every clause is one of four things to an auditor, and the difference decides
what a green `pas check` is worth:

| Level | Meaning | How the audit records it |
|---|---|---|
| **Fully automated** | A platform or compliance check *is* the clause's enforcement (the clause's *Enforcement* line names it, and the check's `automation` is `full`). | The check result is the evidence; `pass`/`fail` follows it. |
| **Partially automated** | A check proves one observable facet of the clause (its `automation` is `partial`); the rest is *Manual*. | The check is cited as evidence for its facet only; the clause's own *Evidence* section still has to be read. A passing check never closes a partially automated clause on its own. |
| **Manual** | No check exists; an AI or a person reads the evidence against the clause. | `pass` / `fail` / `not-applicable` / `manual-review` from the evidence. |
| **Human-only** | The clause's verification class is *Human*. | `manual-review` until a person records the result — never `pass` from an AI. |

**The limit of automated compliance, stated plainly:** the compliance checks
are source and PWA hygiene scans — brand tokens, metas, manifest, service
worker, a fixed tracker list, one `.env` file name, unnamed buttons. They are
**not a security audit** and do not touch a single Security clause of the
[AUTH](./auth.md), [DATA](./data.md) or [OPS](./ops.md) chapters: nothing in
`pas check` reads `mcp.json` scoping predicates, `initPro` options, the
service worker's runtime caching rules, or the deployed app. A repository with
20/20 checks green can still ship an unscoped action and a session in
`localStorage`. Treat every check as at most *partially automated* evidence
for the clause it cites, and never as a substitute for the chapter it belongs
to.

### Compliance checks and the clauses they cite

Each `@proappstore/compliance` check carries a stable id and cites these
clauses in `pas check`, in CI output (`pas check --json`), and in the publish
gate's failure detail. The machine-readable copy of this table is
[`compliance-checks.json`](./compliance-checks.json)
(schema: [`compliance-checks.schema.json`](./compliance-checks.schema.json));
the package's tests fail if a check is unmapped, a clause does not exist, or
this copy drifts. The UI chapter's
[scanner table](./ui.md#what-the-scanner-proves-and-what-needs-a-browser) says the
same from the clause side.

| Check id | Emitted name | Cites | Automation | Limits |
|---|---|---|---|---|
| `license-mit` | MIT License | [PAS-UI-022](ui.md#pas-ui-022) | partial | Assumes MIT while the Pro tier permits proprietary source; a proprietary licence records this as a known platform inconsistency, not an app defect. |
| `no-env-production` | No .env.production | [PAS-OPS-006](ops.md#pas-ops-006), [PAS-STACK-015](stack.md#pas-stack-015), [PAS-UI-022](ui.md#pas-ui-022) | partial | Only the one file name; keys in source, in VITE_* variables, or in other .env files are not detected. |
| `no-placeholders` | No template placeholders | [PAS-UI-020](ui.md#pas-ui-020) | full | Detects the literal APPNAME token only. |
| `no-tracking` | No tracking SDKs | [PAS-UI-022](ui.md#pas-ui-022), [PAS-STACK-021](stack.md#pas-stack-021), [PAS-OPS-018](ops.md#pas-ops-018) | partial | A fixed list of known trackers; a self-hosted or unlisted tracker is not detected. |
| `brand-fonts` | Brand fonts present | [PAS-UI-001](ui.md#pas-ui-001), [PAS-STACK-022](stack.md#pas-stack-022) | partial | Presence of the font names in CSS/HTML; not that they are actually applied. |
| `brand-tokens` | Brand tokens defined | [PAS-UI-001](ui.md#pas-ui-001), [PAS-STACK-022](stack.md#pas-stack-022) | partial | That the canonical tokens are defined; not that the app uses them instead of hard-coded colours. |
| `no-brand-overrides` | No brand overrides | [PAS-UI-001](ui.md#pas-ui-001), [PAS-STACK-022](stack.md#pas-stack-022) | partial | Common override forms only; the banned alias names themselves are caught by the platform design-system lint, not here. |
| `no-scroll` | No scroll (games only) | [PAS-UI-009](ui.md#pas-ui-009) | partial | Games only; static CSS anti-patterns. Real document scroll is measured only in a browser. |
| `viewport-support` | Viewport support | [PAS-UI-008](ui.md#pas-ui-008) | partial | That orientation and min_viewport_width are declared; not that the layout works at that width. |
| `unsafe-vh` | No unsafe 100vh | [PAS-UI-010](ui.md#pas-ui-010) | partial | 100vh in source only; safe-area padding and the iOS first-load scroll need a device. |
| `accessibility-static` | Accessibility static | [PAS-UI-004](ui.md#pas-ui-004) | partial | Missing alt text, unnamed buttons and unlabeled text controls only. Contrast, focus order, keyboard traps and rendered ARIA need a browser and a person (PAS-UI-005, 006, 023). |
| `html-meta` | HTML meta tags | [PAS-UI-008](ui.md#pas-ui-008), [PAS-UI-020](ui.md#pas-ui-020) | partial | Presence of lang, viewport, title and preview images; not the viewport's content (user-scalable=no is PAS-UI-007, a manual check). |
| `pwa-meta` | PWA meta tags | [PAS-UI-020](ui.md#pas-ui-020) | partial | The iOS install metas only; install behaviour is verified on a device. |
| `pwa-offline` | PWA offline correctness | [PAS-UI-018](ui.md#pas-ui-018), [PAS-UI-019](ui.md#pas-ui-019) | partial | That a service worker is registered and the workbox config is sane; not that /.pas/* or authenticated responses stay uncached at runtime. |
| `pwa-manifest` | PWA manifest | [PAS-UI-020](ui.md#pas-ui-020) | partial | The four required fields; the rest of the manifest is reviewed manually. |
| `pwa-maskable-icon` | PWA maskable icon | [PAS-UI-020](ui.md#pas-ui-020) | full | Declaration only; the icon's safe zone is not rendered. |
| `store-link` | Store link | [PAS-UI-001](ui.md#pas-ui-001), [PAS-STACK-022](stack.md#pas-stack-022) | full | That the domain appears somewhere under web/src; not that it is visible. |
| `dark-mode` | Dark mode support | [PAS-UI-002](ui.md#pas-ui-002) | partial | Warn-only signal detection; the storage-key split (fas:theme vs stores-theme) and dark-scheme contrast are manual. |
| `bundle-size` | Bundle size | [PAS-UI-021](ui.md#pas-ui-021), [PAS-STACK-024](stack.md#pas-stack-024) | partial | Warns when web/dist is unbuilt; measures the largest JS chunk only. |
| `claude-md-slim` | CLAUDE.md is slim (no platform boilerplate) | [PAS-STACK-001](stack.md#pas-stack-001) | partial | Documentation hygiene of the scaffold's agent guide; warn-only and not a security signal. |
| `reachable` | Reachable (live) | [PAS-OPS-010](ops.md#pas-ops-010) | partial | HTTP 200 from the live URL; not that the app works (that is the post-deploy smoke). |
| `brand-fonts-live` | Brand fonts (live) | [PAS-UI-001](ui.md#pas-ui-001) | partial | The fonts link in the served HTML only. |
| `bundle-size-live` | Bundle size (live) | [PAS-UI-021](ui.md#pas-ui-021) | partial | HEAD size of the main bundle only. |
| `pwa-manifest-live` | PWA manifest (live) | [PAS-UI-020](ui.md#pas-ui-020) | partial | Manifest reachable and minimally valid. |
| `no-tracking-live` | No tracking SDKs (live) | [PAS-UI-022](ui.md#pas-ui-022), [PAS-STACK-021](stack.md#pas-stack-021) | partial | Known trackers in the served HTML and fetched scripts only. |
| `unsafe-vh-live` | No unsafe 100vh (live) | [PAS-UI-010](ui.md#pas-ui-010) | partial | Served CSS text only. |

## Audit report

An audit report lists every clause in every chapter with its result state, the
evidence considered, and — for `not-applicable` — the reason. Clauses marked
*Withdrawn* in the [governance page](./governance.md#withdrawals) are listed
with the result `not-applicable` and the reason "withdrawn in &lt;version&gt;".
