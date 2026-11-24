---
description: "Apple and Google Play policy findings for the PAS background companion, with precedents and launch requirements."
---

# Native companion: store approval investigation

Researched **2026-11-06**. This is a documented engineering assessment, not approval from either store. Android has a release pipeline; iOS is a developer-installed preview (ADR-016) with no App Store or TestFlight submission. Recheck policies at submission.

## Exact product assessed

One consumer native PAS app uses the same account as PAS web apps. Users separately enable supported services for named apps. PAS collects native data, uploads it to the platform, and the platform exposes it only to those authorized apps. Web apps are not hosted inside PAS. On iOS and Android the companion also has a read-only native storefront (ADR-017, #638): it lists the public catalogue and opens apps in the browser, with no web view and no purchase. Users normally stay in their web apps and visit PAS for discovery, connection, permission decisions and settings.

## Assessment

There is a credible approval path for a transparent location companion on both stores. No blanket prohibition was found against this architecture. This is not evidence that an unrestricted service host, every future capability, or every data-sharing purpose would be accepted.

### Google Play

Rechecked 2026-11-24 against the policies linked at the end of this section. Readiness tracker: #667.

**No background-location declaration.** Collection runs only in sessions the user starts in the app ([ADR-020](./adr/020-native-collection-sessions.md), #668), so the app does not declare `ACCESS_BACKGROUND_LOCATION`, and Play Console does not ask for the Location permissions declaration or its video. A location foreground service started while the app is visible keeps while-in-use access with the phone locked. If a track still holds an older bundle that declares the permission, Play asks anyway. In that case, retire that bundle rather than declare: declare only if Play insists, with one feature, "Records runs and walks for the Run app while the phone is locked".

**Prominent disclosure** (User Data policy). It is shown before the location runtime request. It contains "location", says collection continues "while your phone is locked and the apps are closed", lists every recipient's reviewed purpose (built from `/native/me`, #663), and states the session rules. The per-app consent (the catalog disclosure) comes before it.

**Foreground services.**

- *`location`:* use case "user-initiated location sharing". Description: "Records the route of a run, ski day or driving shift for the apps the user chose, during a session the user starts in the app. An ongoing notification shows it, with Stop. The session also ends after 30 minutes without movement or after 12 hours." *If deferred:* "The run or route has a gap for as long as the service is stopped." *Video (30 s or less):* Sharing → Run → Start → disclosure and precise-location prompt (first time) → the "ProAppStore is sharing your location · With Run" notification → lock the phone and walk → run.proappstore.online showing the points → Stop in the notification.
- *`connectedDevice` (with #634):* "Reads the user's chosen Bluetooth heart-rate strap during a recorded run." *Video:* the in-app Choose sensor sheet and the bpm on Run's row. The policy says it "must show the in-app setup and subsequent device interaction, not system settings".
- Services must "run only for as long as necessary". Sessions provide that: started by a tap, ended by Stop, a 30-minute stationary timeout or a 12-hour cap (ADR-020).

**Health apps declaration.** Every app completes it. Choose Health and fitness → **Activity and Fitness**. Not a medical app. Health Connect (#635) also needs its own Health Connect permissions declaration; keep it out of the first production release.

**Data Safety (draft).** Encrypted in transit: **yes** (HTTPS only, `usesCleartextTraffic="false"`, fixed origin in `PasApi.kt`). Users can request deletion: **yes**, at `https://proappstore.online/privacy#data-deletion`; Disconnect this phone deletes the phone's data without deleting the account. Independent security review: no.

| Data type | Collected | Shared | Optional | Purpose | Basis |
|---|---|---|---|---|---|
| Location: precise | yes | no | yes | App functionality | Only for apps the user enables. Every recipient today is a PAS app from the same developer; the transfer follows a per-app consent. Recheck "shared" whenever an app from another publisher gets a catalog entry. |
| Location: approximate | no | | | | `ACCESS_COARSE_LOCATION` is requested only because Android requires it alongside precise; approximate-only access never collects (`LocationService.allowed`). |
| Personal info: name, email address, user IDs | yes | no | no | Account management, App functionality | Google or GitHub sign-in creates or uses the PAS account; the phone receives the name and id from `/native/me`. |
| Device or other IDs | yes | no | no | App functionality, Fraud prevention and security | The installation credential (random, hashed on the server), the pairing id, and the device label (maker and model). |
| Health and fitness: fitness info | yes, with #634 / #635 | no | yes | App functionality | Heart rate (bpm and time); workout summaries. |
| App info and performance: diagnostics | yes, with #660 | no | yes (off switch; recheck whether a default-on toggle counts as "optional") | App functionality, Analytics | #660's report. |
| App activity: app interactions | yes, with #660 | no | yes | App functionality, Analytics | The activity log inside #660's report records when the user enabled, paused and resumed sharing. #660 lists only Diagnostics; declare this too. |

Not declared because it stays on the phone (Play exempts on-device-only data): the 30-day sharing history, strap names, and Store searches. Not collected: financial info, messages, photos, audio, files, calendar, contacts, browsing history, installed apps (the release manifest has no `QUERY_ALL_PACKAGES`).

**Content rating (IARC).** Category: utility / productivity / other. Violence, sexuality, language, controlled substances, gambling: none. Users interact or exchange content: no. **Shares the user's current physical location with other users: yes** (Rideshare shows a driver's position to their rider). Digital purchases: no. Unrestricted web browsing: no (links open the system browser).

**Target audience:** 18 and over only, with Restrict Minor Access (decided in #661). Child PAS accounts cannot pair (#669). **Ads:** none. **News, government, financial features:** no.

**App access:** a dedicated review account and instructions (#666).

Sources: [background location](https://support.google.com/googleplay/android-developer/answer/9799150), [foreground-service declarations](https://support.google.com/googleplay/android-developer/answer/13392821), [Device and Network Abuse](https://support.google.com/googleplay/android-developer/answer/9888379), [sensitive permissions](https://support.google.com/googleplay/android-developer/answer/9888170), [User Data](https://support.google.com/googleplay/android-developer/answer/10144311), [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469), [account deletion](https://support.google.com/googleplay/android-developer/answer/13327111), [Health apps declaration](https://support.google.com/googleplay/android-developer/answer/14738291), [target audience](https://support.google.com/googleplay/android-developer/answer/9867159), [app access](https://support.google.com/googleplay/android-developer/answer/9859455).

### Apple, for a later iOS implementation

Location is an allowed background purpose (§2.5.4), must relate directly to the app's service (§5.1.5), and needs consent and appropriate collection/sharing controls (§5.1). Minimum functionality (§4.2) creates uncertainty for a nearly empty permissions app. A useful native connection/status/privacy control panel strengthens the product's utility without hosting the recipient apps.

Our interpretation is that §4.7's hosted mini-app category is not the obvious fit for a standalone companion sending data through a backend. Apple has not confirmed that interpretation. Do not claim an exemption from review or try to disguise app hosting as a companion. The native app must also meet ordinary login, account deletion, privacy and distribution requirements.

The storefront (ADR-017) strengthens the §4.2 case. It has no purchase or subscription link; if one is ever added, it is a §3.1.1 question at submission: recheck the current link-out rules for each storefront region.

Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

### Heart rate from a Bluetooth strap (`heart_rate.ble`, #631, #634)

**iOS `bluetooth-central` background mode.** Justification: *reads a user-chosen fitness sensor during the user's activity*. The companion scans only from a foreground sheet the user opens, for the standard Heart Rate Service (`0x180D`) only, and connects to the one sensor the user picks. Locked-screen delivery uses a pending connection to that identifier plus state restoration; there is no background scan. `NSBluetoothAlwaysUsageDescription`: "ProAppStore reads the heart-rate sensor you choose for the apps you enable, such as Run, including while your phone is locked."

**App Review 5.1.3 (health and fitness data).** The specific data is disclosed before the grant (bpm and time only; the sensor's name and identifier stay on the phone). It is never used for advertising or marketing, never written to iCloud (the queue and history file is excluded from backup), and it is made available only to Run, for that user's own fitness record, with the user's permission. HealthKit is not used.

**Google Play.** The collector's foreground service declares `location|connectedDevice` and starts with only the types whose permission is held and whose grant is active.

- *Foreground-service declaration, `connectedDevice`:* "ProAppStore keeps a connection to a Bluetooth heart-rate strap the user chose, while they exercise, so the readings reach the fitness app they enabled (Run) with the screen off. The ongoing notification names what is shared and offers Stop; turning heart rate off or forgetting the sensor ends the connection."
- *Data Safety:* **Health and fitness → Fitness info**: collected, shared with the enabled PAS app for the user's account, not used for advertising, encrypted in transit, deletable (turn off, disconnect, or delete the app account); not processed ephemerally; required only for the heart-rate feature, which is optional.
- Bluetooth permissions: `BLUETOOTH_SCAN` with `neverForLocation` and `BLUETOOTH_CONNECT` on API 31+, the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` up to API 30. On Android 10 and 11 the platform requires fine location for any BLE scan, so Choose sensor asks for it there; the scan still lists heart-rate sensors only.

## Relevant precedents

- **OwnTracks** is listed on [App Store](https://apps.apple.com/us/app/owntracks/id692424691) and [Google Play](https://play.google.com/store/apps/details?id=org.owntracks.android). Its [documented architecture](https://owntracks.org/booklet/guide/whathow/) publishes background location to a server for downstream use.
- **Home Assistant Companion** documents [background location and per-server sharing controls](https://companion.home-assistant.io/docs/core/location/). Its background sensor/native-capability role is relevant, although it also contains features PAS is not proposing.

These are feasibility precedents, not transferable approvals. Neither establishes that high-frequency tracking, every recipient or every use is acceptable.

## Submission evidence to prepare

- Working consumer account and live backend, named recipient app, reproducible permission flow.
- Videos as listed under Google Play above, one per declaration, 30 s or less each.
- Explain automatic recording and its user benefit, accuracy mode, collection duration, offline queue, retention and battery behaviour.
- Show Stop and Stop all, per-app revocation, disconnect and deletion; disclose offline revocation latency and separately saved app data.
- Finish Google Play declarations, privacy policy, Data Safety, app signing and account-deletion requirements. Target API 36, 64-bit and 16 KB page alignment are verified (readiness tracker #667).
- No developer console, arbitrary code loading, covert tracking, advertising use of location or blanket grants to future apps.

Collection now runs only in sessions the user starts in the companion, which end on Stop, after 30 minutes without movement or after 12 hours ([ADR-020](./adr/020-native-collection-sessions.md)). That meets Play's rule that a location foreground service continue a user action and stop when the use is complete, and removes `ACCESS_BACKGROUND_LOCATION` from the Android app.

## Runtime acceptance is separate

Approval does not ensure continuous delivery. Test permission revocation, approximate-only access, screen lock, app switch, OS process death, explicit force-stop, restart, no GPS, airplane mode, reconnection, low storage, duplicate uploads, account changes and recipient revocation. Sparse significant-change observations cannot reconstruct a precise ski route. Report gaps and measured accuracy honestly.
