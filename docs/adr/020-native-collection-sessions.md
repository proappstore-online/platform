---
description: "Native collection runs in sessions the user starts and that end on their own; supersedes ADR-015's always-on collection."
---

# ADR-020: Native collection runs in user-started sessions

## Status

Accepted. Supersedes the parts of ADR-015 that make collection continuous once an app is enabled (its Context's "automatic routes", and "The user does not need to open PAS for each ride" in `native-companion.md`). Everything else in ADR-015 and ADR-018 stands.

## Date

2026-11-24

## Context

ADR-015 had the companion collect whenever an app held a grant, until the user paused it. On Android that meant a location foreground service running all day; on iOS, continuous updates plus significant-change relaunches. The recipients use only part of it: Run keeps location only during a recording, Rideshare only while the driver is online, Ski only during a day on the slopes.

Google Play requires a location foreground service to start as a continuation of a user action in the app and to stop once that use is complete, and requires location access to stop once it is no longer needed for a feature. Continuous collection that the recipient discards meets neither requirement, costs battery, and uploads location nobody uses.

## Decision

1. **A session** is (app, start time). The phone collects for an app only while it has a session for that app. Several apps can have sessions at once; one collector serves them all (ADR-015 §5 is unchanged).
2. **Starting needs the user, in the app.** A session starts only from a tap in the companion: Start on the app's row, or Start in the prompt a `proappstore://native/apps/<appId>` link brings forward. A link never starts a session, as it never grants (ADR-018 §9). Starting needs a current grant, precise location permission, and location turned on.
3. **A session ends** on the first of these:
   - the user taps Stop on the app's row, Stop all, or the notification's Stop;
   - no movement for `STATIONARY_TIMEOUT` (30 minutes);
   - `MAX_SESSION` (12 hours) after it started;
   - its grant is disabled, revoked, replaced or expires, the device is disconnected, or precise permission is withdrawn.

   "Movement" means an emitted point that moved at least the emit threshold (ADR-015's emit filter, #639). The first point and heartbeats are not movement. No fixes at all counts as no movement.
4. **An automatic end is visible.** A notification names the app and the reason, for example "Stopped sharing with Run: no movement for 30 minutes". Tapping it opens the companion; it does not restart anything.
5. **While a session runs, the platform's rules are unchanged:** the ongoing notification, per-point grant snapshots, the queue, upload, and revocation. The notification names the apps and has a single **Stop** action, which ends every session.
6. **Sessions are local to the phone.** They are not reported to the app or the platform, like pause before them. The recipient sees points or no points. *Amended by [ADR-019](./019-native-diagnostics-and-owner-access.md) decision 6: with Diagnostics on, the phone's sessions are in its diagnostics report, readable by the user only; still never by an app.*
7. **Interrupted sessions.** If the OS kills the collector, an unexpired session (under `MAX_SESSION`, not ended) resumes the next time the user opens the companion, and the stationary clock restarts. Nothing restarts it in the background.
8. **Permissions.** Sessions always start with the app visible, so neither platform asks for "all the time" / "Always" location for collection. Android does not declare `ACCESS_BACKGROUND_LOCATION`. iOS keeps "When In Use" plus its background-location mode, and no longer uses significant-change relaunches.
9. **Pause becomes Stop.** Per-app Pause (#626) and Pause all are replaced by Stop and Stop all. Like Pause, Stop never touches the grant or consent, and Start needs no new disclosure.
10. **Catalog entries are unchanged.** Their disclosures already describe collection while the phone is locked and the app is closed, which stays true during a session. Their hashes are pinned (ADR-018 §4).
11. **A session is per app, and needs the app's location.** Every capability an app has, heart rate included, is collected only while that app has a session, and a session starts only for an app whose location is enabled (decision 2). So the companion offers to enable another capability, such as Run's heart rate, only once that app's location is enabled, and says so where it would offer it; there is no heart-rate-only session in v1 (#668). Turning off one capability ends the session only when the app has no enabled capability left: turning off Run's location during a session leaves its heart rate running until the session ends, and never starts or resumes the other capability of a stopped app. Stopping a session stops all of the app's capabilities. iOS follows the same rule (#677).

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Keep always-on collection (ADR-015) | Conflicts with Play's foreground-service and location-access rules; collects location no recipient uses; battery. |
| Start automatically from activity recognition or geofences | Needs Google Play services (ADR-015 chose LocationManager), and Android 12+ forbids starting a foreground service from the background (#641). |
| A link that starts a session directly | A custom scheme carries no origin (ADR-018 §5); any site could start collection. The tap stays in the companion. |
| The recipient app starts and stops sessions through the platform | Needs a Deliver path to the phone (push) and a background start, neither of which exists. Recorded as a later option. |
| Keep Pause alongside sessions | Two overlapping stop concepts; Stop keeps every guarantee Pause gave. |

## Consequences

**Positive:** collection matches what recipients use; the Play submission needs no background-location declaration; less battery; one model on both platforms.

**Negative:** the user starts each activity, from the companion or from the app's link. A session cut short by the timeout leaves a gap until the user starts again.

**Neutral:** the timeout and maximum length are platform constants, the same for every app, until a reviewed per-app value is needed.
