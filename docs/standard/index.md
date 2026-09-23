# Recommended Application Standard and Audit Guide

**Standard version 1.1** · [Changelog](./changelog.md) · [Governance and versioning](./governance.md) · [Audit model](./audit-model.md)

This is the canonical, clause-numbered standard for how an application built on
ProAppStore should be designed and implemented. It exists so that developers and
AI copilots use the platform's primitives rather than inventing weaker
substitutes, bypassing them, or cutting security and quality corners.

The capability pages elsewhere in these docs answer *what ProAppStore provides*.
The standard answers *when an app should use it, how, what is unsafe, what
evidence shows correct use, and what to do when the evidence is missing*.

## What the standard is — and is not

| Kind of statement | Meaning | Marked as |
|---|---|---|
| **Recommended conformity** | Advisory. `MUST`/`SHOULD`/`MAY` describe conformity with this standard. Not conforming is a finding, not a storefront rejection. | Default for every clause |
| **Automated enforcement** | The clause is mapped to a platform or compliance check that runs at publish or deploy time. A failure blocks or flags the app in the platform, independently of this document. | `Enforcement: automated — <check id>` in the clause |
| **Optional capability** | A platform feature the app *may* adopt. Its absence is never a finding. | `MAY` clauses |

The standard does not introduce a certification programme. Nothing here changes
what the store accepts unless the clause says so explicitly under
*Enforcement*.

## How to audit an app

A non-technical app owner can hand this guide to an AI copilot and ask it to
audit a repository. The procedure is the same for a human reviewer.

1. **Inspect the repository.** Read `package.json`, `wrangler.toml`,
   `mcp.json`, `migrations.json`, `.github/workflows/`, and `web/src/`. Note
   the SDK version and the `initPro()` options.
2. **Decide which platform services the app should be using.** For each
   capability the app needs (auth, data, storage, real-time, secrets, AI, …),
   the [Stack and services chapter](./stack.md) says which platform primitive
   is expected instead of a home-grown substitute.
3. **Walk every applicable clause.** For each chapter, evaluate each clause's
   *Applicability*; record why any clause is not applicable. Then compare the
   listed *Evidence* against the repository.
4. **Record a result per clause**: `pass`, `fail`, `not-applicable`, or
   `manual-review`. The [audit model](./audit-model.md) defines each state and
   the evidence classes.
5. **Open one bounded issue per genuine failure**, citing the exact public
   clause URL (for example
   `https://docs.proappstore.online/standard/auth/#pas-auth-001`), the file and
   line evidence, the impact, the remediation, and the acceptance tests. The
   finding fields are listed in [Findings](./audit-model.md#findings).
6. **Fix failures inside the standard.** Each clause's *Remediation* and
   *Tests* say what a fix looks like and how to prove it. Do not invent
   architecture the standard does not describe; if a clause cannot be met,
   the issue should say so and be flagged for human validation.

## Chapters

Chapter codes are part of every clause ID (`PAS-<CHAPTER>-<NNN>`). The
[governance page](./governance.md#chapter-taxonomy) defines the taxonomy and
what each chapter covers.

| Chapter | Code | Covers |
|---|---|---|
| [Stack and platform services](./stack.md) | `STACK` | Supported runtime, SDK/CLI, and which platform service to use for each need |
| [Identity, sessions, and permissions](./auth.md) | `AUTH` | Platform-cookie authentication, sign-in/out, platform/team/app RBAC, permissions UI |
| [Data, actions, and Workers](./data.md) | `DATA` | D1 schema and migrations, registered actions, row scoping, KV, counters, storage, rooms, Workers and service bindings |
| [Integrations and platform services](./integrations.md) | `INT` | Proxy and secrets, AI, maps, notifications, email/SMS, webhooks, subscriptions and licenses, MCP tools |
| [UI, browser security, and PWA](./ui.md) | `UI` | UI components, browser security, accessibility, responsive and mobile behaviour, PWA |
| [Testing, deployment, and operations](./ops.md) | `OPS` | Testing, CI and OIDC deployment, rollback, logging and monitoring, privacy, dependency policy |

## Where this sits among the docs

- [Architecture](../architecture.md), [Auth and sessions](../auth-session-model.md),
  [Authorization model](../authorization-model.md) and
  [App actions security](../app-actions-security.md) describe how the platform
  works. Clauses link to them as *Supporting links* and never restate them.
- The [SDK](../sdk-overview.md), [UI components](../ui.md) and
  [Recipes](../recipes.md) pages are the implementation references a clause's
  *Recommended implementation* points at.
- Compliance checks that enforce a clause are listed in the clause itself
  under *Enforcement*.
