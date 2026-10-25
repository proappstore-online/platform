---
description: Current PAS delivery priorities, verified MCP capabilities and the acceptance gates for keyless app testing and production background workers.
---

# Platform delivery roadmap

Reviewed 25 October 2026. This page separates existing capabilities from work
still needed for release acceptance. Linked issues hold the current execution
status; this page is not a promise that every item is generally available.

## Available today

PAS has its own backend, identity, registry, R2 app host and per-app D1 data
workers. Approved templates, source editing, provisioning, deployment inspection,
QA and registered app actions are available through the general
[PAS MCP](mcp-app-tools.md). Use the live catalogue to discover current tools,
check `whoami`, then inspect a target before making changes.

Keyless GitHub Actions test-session exchange is deployed. Platform admins can
manage repository/workflow/ref grants through MCP; an existing dedicated GitHub
or Google smoke account can receive a short-lived non-admin test session. See
[the keyless setup](publishing-flow.md#keyless-e2e-sessions). The managed
test-principal API also exists; its complete management and integration
acceptance remains part of #432 below.

Billing and entitlements have implementations. The product model remains one
platform subscription, with no per-app purchases or upgrade prompts. The
intended usage-based developer split does not mean payouts are currently
enabled; see [payout metering](payout-metering.md).

## 1. Finish deployed acceptance

Close the safe database-rejection rollout
([#473](https://github.com/proappstore-online/platform/issues/473)) using real
registered actions: stale revisions and operation conflicts must return safe
409s, other constraints safe 422s, and rejected batches must leave data intact.
Existing data workers need the updated script, not just a new backend deploy.

HR is a reference app for People workflows. Its browser-history regression has
production evidence
([HR #107](https://github.com/proappstore-online/hr/issues/107)); its broader
employee, manager, outsider and revocation acceptance remains separate
([HR #28](https://github.com/proappstore-online/hr/issues/28)). An owner-only
smoke test does not prove every role or tenant boundary.

## 2. Make authenticated testing automatic

Complete managed test principals, administration, audit and CI integration
([#432](https://github.com/proappstore-online/platform/issues/432)), then provision
keyless test login by default for every new app
([#462](https://github.com/proappstore-online/platform/issues/462)).

The reference path should need no pasted session, password or personal account:
create through MCP, deploy, apply schema/register actions, mint a scoped CI test
session, run the authenticated smoke, and inspect its result. Missing test
authentication must be reported as incomplete verification, rather than a
successful signed-in test. Preserve explicit expiry, revocation and synthetic
data isolation.

## 3. Meet background-worker release gates

App workers remain subject to [ADR-009](adr/009-app-workers.md). Complete runtime
limits, outbound controls, cross-app isolation and a live key-rotation drill
before opening them to every app
([#267](https://github.com/proappstore-online/platform/issues/267)). Quota
calibration requires the specified fourteen-day usage window
([#306](https://github.com/proappstore-online/platform/issues/306)); implementation
tests cannot substitute for measured production usage.

The reference app's current stability window starts on 24 October 2026 UTC;
review is due on or after **7 November 2026 UTC** if the hourly history remains
clean ([DuperDash #7](https://github.com/proappstore-online/duperdash/issues/7)).
That observation is a release gate, not an implementation task to mark complete
ahead of the measurement window.

Scheduled email/push and GrassKarma reminders are a further release
([#466](https://github.com/proappstore-online/platform/issues/466)): sending
permissions, quotas, recipient eligibility, opt-outs, duplicate prevention and
delivery audit must pass acceptance before reminders are enabled.

## 4. Reconcile operations and discovery

Resolve orphan resources from verified ownership and registry evidence
([#446](https://github.com/proappstore-online/platform/issues/446)). Keep app
classification and intended-public listing copy current
([#474](https://github.com/proappstore-online/platform/issues/474)), and improve
developer-documentation descriptions
([#483](https://github.com/proappstore-online/platform/issues/483)). Registration,
healthy hosting and storefront publication are distinct states; publish an app
only when its owner requests publication and release requirements are met.

The repository's [product strategy](https://github.com/proappstore-online/platform/blob/main/STRATEGY.md)
describes the longer-term Tailored/Ready model and services direction. Current
[architecture](architecture.md), binding ADRs and issue acceptance govern the
implementation.
