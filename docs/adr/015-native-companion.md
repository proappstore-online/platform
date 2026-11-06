---
description: "Android-first consumer companion for shared native capabilities, with PAS identity and per-app authorization."
---

# ADR-015: PAS native companion for app users

## Status and date

Accepted, 2026-11-06. Android implementation started; public store distribution is not approved or submitted.

## Context

PAS web apps cannot reliably collect location with the phone locked. Ski currently pauses its browser recorder when hidden. Users want automatic routes to be available when they reopen Ski, and want the same native installation to serve other authorized PAS apps such as Rideshare.

The user explicitly chose a **companion**, not an app container. Users remain in their existing web apps. They visit the native app for initial account connection, capability consent and occasional settings. It is for PAS app users, not creators, developers or operators.

## Decision

1. Keep the Android project in the platform repository at `android/`. Use **Kotlin, Jetpack Compose and Material 3** with native Android services. No WebView, React Native or Flutter. This is a new platform client; it does not change the web app stack or ADR-001's Cloudflare backend requirement.
2. Reuse the PAS account and control plane. The native installation has a narrow, expiring, individually revocable credential. It never receives creator/admin authority or a web app's session. Browser sign-in uses existing PAS providers and one-time code redemption; the device proves possession of its own pairing verifier.
3. Native capabilities are implemented in the signed Android binary. An app requests a named capability with a factual purpose/disclosure. Neither an app declaration nor an OS permission creates a user grant. No remote executable plugins or arbitrary background JavaScript.
4. The platform owns consent and authorization. A grant is scoped to user, installation, PAS app, capability, publisher and disclosure version. Apply ADR-014's separation between shared credentials and individual app authorization. New apps and expanded capabilities default off.
5. One native location collector can supply several authorized apps. Capture snapshots its recipient grants; ingestion checks them again. Account identity and app scope come from verified credentials, never an uploaded `userId` or a caller-selected worker identity.
6. Native collection and app-specific processing are separate. The phone buffers observations, the platform accepts them idempotently, and each app processes only its authorized stream. App workers continue to use ADR-009's sandbox and platform-mediated interfaces.
7. Turning off one app does not turn off other apps. Pause all stops collection. Disconnect revokes the device and deletes its platform buffer. Revocation does not promise to erase derived data an app already saved; app-specific deletion must be separately implemented and disclosed.
8. The capability framework can grow to supported notifications, geofencing, Bluetooth, health, media and file transfers. Each needs its own implementation, consent, data lifecycle and store review. The existence of PAS is not permission to run unrestricted services.

## First implementation boundary

The first vertical slice implements Android account connection, reviewed Ski location consent, foreground location service, offline queue, device upload, seven-day platform retention and an app-bound user read API. It does **not** yet implement worker event delivery, the web SDK permission handoff, automatic reboot recovery, native push, lock-screen ride timers, another app's integration, or store release signing. These are explicit follow-ups, not hidden production capabilities.

The initial catalog is curated in platform source. Ski is the first integration; Rideshare is a design example until its own purpose and data lifecycle are reviewed. A future manifest/declaration path must preserve the same platform-owned consent boundary.

## Alternatives

| Alternative | Reason not chosen |
|---|---|
| Separate native binary per PAS app | Repeats identity, permissions, offline persistence and sensor collection. |
| Host all PAS web apps in a native container | Not the requested product; adds mini-app execution and review concerns. |
| Keep browser JavaScript alive with audio/wake-lock workarounds | Does not provide reliable supported background recording. |
| General remotely programmable native daemon | Unsupported by the intended OS model, hard to secure and review. |
| New Firebase identity/backend | Violates the single PAS account and existing Cloudflare architecture. |

## Consequences

The OS displays ProAppStore as the collector. PAS must clearly identify the recipient apps and enforce their grants. A compromised device credential is constrained to that installation's companion endpoints. Publishers never receive it.

Store approval and runtime continuity are distinct: the OS may revoke permissions, stop the app, restrict power or withhold accurate fixes. A gap must remain a gap. PAS must not claim an exact uninterrupted route when it lacks samples.

See [implementation and protocol](../native-companion.md) and [store review findings](../native-companion-review.md).
