---
description: "Native capability registry for the PAS companion: reviewed (app, capability) entries, three data-flow shapes, and per-capability consent, retention and server enforcement."
---

# ADR-018: Native capability registry

## Status

Accepted. Extends ADR-015 and ADR-016; supersedes neither.

## Date

2026-11-23

## Context

ADR-015 §8 expected the companion to grow beyond location, each capability with its own implementation, consent, data lifecycle and store review. The first implementation was location-only in its schema (`CHECK(capability = 'location.background')`), its grant writes, its catalog lookups (by app id alone) and its revocations (all of an app's grants). A second capability for an app that already has location could not be added without crossing grants.

The contract version is the SHA-256 of a whole catalog entry, so new metadata cannot be added to existing entries without revoking their grants.

"Capability" already names browser Permissions-Policy features (`docs/app-capabilities.md`) and "permissions" names `mcp.json` listing declarations. Native capabilities differ from both: the platform collects or acts on the user's behalf, per app, under platform-owned consent.

## Decision

1. **The registry is reviewed platform source**, in `packages/backend/src/lib/native-companion.ts`, as two lists:
   - `NATIVE_CAPABILITIES`: one **definition** per capability id, holding platform facts: display name, flow shape, platform retention, and the OS features it needs. Definitions are not consent text and are not hashed.
   - `NATIVE_CATALOG`: one **recipient entry** per (app, capability), holding the app id, app name, capability, purpose and disclosure. The entry's hash is its contract version. Existing entries are never reshaped.

   Apps never register themselves. An `mcp.json` declaration may later *request* a capability, but only a reviewed entry in source makes it grantable.
2. **Ids** are lowercase `<domain>.<qualifier>`: `location.background` (existing), `heart_rate.ble`, `health.workouts`, `notifications.relay`. An id is never reused for different data.
3. **A grant** is (device, app, capability, publisher, contract version, consent time), the columns ADR-015 already defined. The database checks the id's format. Membership is enforced because the grant insert takes its capability from the reviewed entry, never from the request. Enabling, disabling or revising one capability never touches another capability's grant, whether for the same app or any other.
4. **Everything the user consents to is in the disclosure text**: what is collected, when, who receives it, and how long the platform keeps it. Changing any of these changes the hash, which revokes the grant. A definition change that would contradict an existing disclosure (for example, longer retention) must edit that disclosure in the same change. Every entry's hash is pinned by a test.
5. **Three data-flow shapes.** Every capability is exactly one of these:
   - **Collect (phone → platform → app).** For example location, heart rate and workouts. The phone uploads idempotent batches, and each sample carries the grant ids current when it was captured. Ingestion rechecks grant, capability, publisher, contract version and device expiry *at the write*. Each capability has its own table with an `ON DELETE CASCADE` foreign key to its grant, and its own field `CHECK`s. The app reads through the app-bound user gate with the composite `(at, cursorId)` cursor. The platform buffer expires per definition (7 days unless stated). No sample from before consent is accepted.
   - **Deliver (platform → phone).** For example a notification relay. The platform sends to a device on an app's behalf only while that user's grant for that app is current. The phone registers a delivery token bound to its own device credential. The payload is what the app sent plus the app's reviewed name, any link is restricted to the app's own origin, and the platform stores no payload.
   - **Act (app → phone → app, user present).** For example scanning, NFC, a calendar write, a contact pick or a share. The web app asks the platform for a request through its app-bound session and gets an opaque id. The link the phone opens carries only that id. The phone fetches the request with its device credential and shows the requesting app's name *as the platform states it*, not as the link claims. It acts only with the user present, then posts the result. The web app reads the result once. Requests and results expire after 10 minutes and are deleted when read. A custom URL scheme carries no origin, so without the server step any website could open a link claiming to be another PAS app. This shape is recorded now so the first such capability does not invent its own path; this ADR does not build it.
6. **Web status.** `GET /apps/:appId/native/status` keeps its location fields unchanged and adds `capabilities: { [id]: { available, enabled, lastAt } }` for every capability that has an entry for the app. It returns no device identity. A capability whose delivery path is not configured (for example a missing push key) reports `available: false`.
7. **Phone catalog.** `GET /native/me` keeps `apps` as **location entries only, in today's shape**, so shipped clients keep working. It adds `capabilities`, which lists every entry with its grant, for clients that understand it.
8. **Public facts.** The storefront listing exposes each app's reviewed native capabilities by display name. Per-user control surfaces show one item per (app, capability) grant. Both read the registry; neither creates entries.
9. **Links.** `proappstore://native/apps/<appId>/<capability>` brings a disclosure forward, and `proappstore://native/apps/<appId>` keeps meaning location. A link never grants anything.
10. **Store review is per capability.** Each capability ships with its own usage strings, background-mode justification and an entry in `docs/native-companion-review.md` before any submission. Health and fitness data (HealthKit, Health Connect, Bluetooth heart rate, motion) follow App Review 5.1.3: the specific data is disclosed, it is never used for advertising or marketing, it is never stored in iCloud, and it is disclosed to a recipient app only for that user's health or fitness management, with permission. A Deliver capability on iOS needs the Apple Developer Program, because personal teams cannot use push.
11. **Unchanged boundaries.** The device credential is still accepted only by `/native/*`. No capability runs app code on the phone. No capability gives an app worker direct access (ADR-015 milestone 3 still governs worker delivery).

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| One generic samples table with a JSON payload | Loses per-field `CHECK`s and per-capability indexes; a bug in one capability's writer could corrupt another's reads. One table per Collect capability costs one additive migration each. |
| Keep an enumerated `CHECK` and extend it for each capability | Every extension is a rebuild of `native_grants`, and dropping that table cascades into every child table. Do the rebuild once and enforce membership in code. |
| Add metadata (retention, scopes) to existing catalog entries | Changes their hash and revokes every existing grant. |
| Let `mcp.json` declare native capabilities directly | ADR-015 §3: an app declaration never creates a grant or a capability. |
| Act shape with the request carried entirely in the link | No authenticity: the phone could not tell which app asked. |
| One status endpoint per capability | More round trips for the same gate; one map answers the web UI in one read. |

## Consequences

**Positive:**
- One grant model across capabilities. Control surfaces and the storefront read one registry.
- A capability can be revoked without affecting the app's other capabilities.

**Negative:**
- One migration per Collect capability, and one careful `native_grants` rebuild now.
- Review work (usage strings, policy notes, device acceptance) remains per capability and is not shared.

**Neutral:**
- The storefront and control surfaces gain a dependency on the registry's display names.
