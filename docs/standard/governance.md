# Governance, clause IDs, and versioning

**Standard version 1.3** · Part of the [Application Standard](./index.md)

This page is the rulebook for the standard itself: how chapters are organised,
how clauses are identified and written, what the normative keywords mean, and
how the standard changes over time.

## Chapter taxonomy

The standard is organised into six chapters. Each has a fixed code that forms
part of every clause ID in it. Chapters are added only in a major version.

| Code | Chapter | Scope |
|---|---|---|
| `STACK` | [Stack and platform services](./stack.md) | Supported runtime and toolchain; SDK and CLI use; the platform service to use for each application need, and the substitutes that are unsupported |
| `AUTH` | [Identity, sessions, and permissions](./auth.md) | Platform-cookie authentication, sign-in and sign-out, platform/team/app RBAC, permissions UI |
| `DATA` | [Data, actions, and Workers](./data.md) | D1 schema and migrations, registered actions, per-user/project/tenant row scoping, KV, counters, storage, rooms and Durable Objects, Workers and service bindings |
| `INT` | [Integrations and platform services](./integrations.md) | Proxy and secrets, AI, maps, notifications, email and SMS, webhooks, subscriptions and licenses, MCP tools |
| `UI` | [UI, browser security, and PWA](./ui.md) | UI components, browser security headers and storage, accessibility, responsive and mobile behaviour, PWA |
| `OPS` | [Testing, deployment, and operations](./ops.md) | Testing, CI and OIDC deployment, rollback, logging and monitoring, privacy, dependency policy |

## Clause ID grammar

Every clause has a stable ID of the form:

```
PAS-<CHAPTER>-<NNN>
```

- `PAS` is the standard's prefix and never changes.
- `<CHAPTER>` is one of the chapter codes above.
- `<NNN>` is a three-digit number starting at `001`, assigned in order of
  publication within the chapter. Numbers are never reused.

Examples: `PAS-AUTH-001`, `PAS-DATA-017`.

### Anchors and URLs

Each clause is a level-3 heading whose text starts with the ID, and it carries
an explicit anchor equal to the ID in lower case:

```markdown
### PAS-AUTH-001 — Sessions use the platform cookie {#pas-auth-001}
```

The anchor is what makes the URL stable: the heading *title* may be edited for
clarity, the anchor may not. The public URL of a clause is therefore

```
https://docs.proappstore.online/standard/<chapter page>/#<id in lower case>
```

for example `https://docs.proappstore.online/standard/auth/#pas-auth-001`.
Findings cite this URL and nothing else.

A test in the platform repository (`test/docs-standard.test.ts`) fails the
build if two clauses share an ID, if a clause heading lacks its anchor, if an
anchor does not match its ID, if IDs in a chapter are out of order, or if a
link into the standard points at a page or clause that does not exist.

## Normative keywords

The key words below have the meanings given here. They describe conformity
with this standard only; they do not on their own create a platform rule.

| Keyword | Meaning for the app | Result when not met |
|---|---|---|
| `MUST` / `MUST NOT` | Required for conformity. There is no acceptable reason to deviate within the platform's supported patterns. | `fail` at the clause's severity |
| `SHOULD` / `SHOULD NOT` | Expected for conformity. A deviation is acceptable only with a documented reason that the auditor records and flags for human validation. | `fail`, with the deviation noted |
| `MAY` | An optional capability the app can adopt. | never `fail`; `not-applicable` if unused |

Whether a clause is *also* enforced by the platform is stated separately, in
the clause's *Enforcement* line, so that recommendation and enforcement are
never confused:

| Enforcement line | Meaning |
|---|---|
| `Enforcement: none (recommended)` | Advisory only. The default. |
| `Enforcement: automated — <check id>` | A named platform or compliance check enforces the clause at publish or deploy time. The check, not this document, is what blocks or flags the app. |
| `Enforcement: optional capability` | Used with `MAY` clauses. |

## Clause template

Every clause is written from this template, in this order, with every section
present. A section that genuinely has nothing to say reads "None." rather
than being omitted, so that a missing section is detectable.

````markdown
### PAS-<CHAPTER>-<NNN> — <Title, a short statement of the rule> {#pas-<chapter>-<nnn>}

**Severity:** <Critical | High | Medium | Low | Info> · **Verification:** <Automated | Manual | Human> · **Enforcement:** <none (recommended) | automated — <check id> | optional capability> · **Since:** <standard version>

**Rule.** The app <MUST | MUST NOT | SHOULD | SHOULD NOT | MAY> …

**Applicability.** <All apps | Apps that …>

**Rationale.** <The threat or failure mode this prevents.>

**Recommended implementation.** <The platform pattern, with links to the capability page and SDK reference.>

**Conforming example.**

```ts
// minimal example that meets the rule
```

**Non-conforming example.**

```ts
// the shortcut or substitute this rule exists to prevent
```

**Evidence.** <Evidence class: what to inspect, where — e.g. Source: `web/src/lib/app.ts`, the `initPro()` options.>

**Remediation.** <The bounded change that brings the app into conformity.>

**Tests.** <The automated or manual check that proves the fix.>

**Supporting links.** <Capability page(s), SDK reference, related clauses.>
````

Requirements on the template's use:

- The *Title* states the rule so that a finding titled from the defect still
  reads sensibly next to it.
- *Evidence* names at least one concrete location and its evidence class from
  the [audit model](./audit-model.md#evidence-classes).
- *Remediation* is bounded: one app, one clause, one pull request.
- *Tests* names something runnable or a manual check with an unambiguous
  expected outcome.
- *Supporting links* always includes the capability page the clause relies
  on. Clauses link to capability pages; they do not restate them.

## Versioning

The standard is versioned independently of the platform and the SDK, as
`MAJOR.MINOR`. The current version is stated at the top of every page.

| Change | Version bump | Allowed effect on IDs |
|---|---|---|
| Add a clause to an existing chapter | Minor | New ID, next number in the chapter |
| Clarify a clause without changing what conforms | Minor | None |
| Change what conforms (rule, severity, applicability) | Minor, and the clause's *Since* line is updated to the version of the change | None |
| Withdraw a clause | Minor | ID retained, clause marked withdrawn |
| Add or rename a chapter, or renumber clauses | Major | Only here |

Within a major version, clause IDs are **append-only**: numbers are assigned
in increasing order and never reused, and a published clause is never removed
from its page. An audit therefore always names the version it ran against,
and a finding's clause URL stays valid across minor versions.

## Withdrawals

A clause that no longer applies — because the platform changed, or because it
was superseded — is **withdrawn**, not deleted or renumbered:

- The heading and anchor stay exactly as published.
- The severity line is replaced by `**Withdrawn in <version>.** <reason, and the superseding clause ID if any>`.
- The remaining sections are removed.
- The withdrawal is listed in the [changelog](./changelog.md).

An audit records a withdrawn clause as `not-applicable` with the reason
"withdrawn in <version>".

## Changelog policy

The [changelog](./changelog.md) has one entry per published version, newest
first. Each entry lists, by clause ID:

- **Added** — new clauses.
- **Changed** — clauses whose rule, severity, or applicability changed, with
  one line on what changed.
- **Withdrawn** — withdrawn clauses, with the reason.
- **Editorial** — wording, link, and example changes that do not alter what
  conforms. May be summarised in one line.

A version is published when its changelog entry is committed to `main`; the
docs site is rebuilt from `main` on every push.
