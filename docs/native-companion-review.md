---
description: "Apple and Google Play policy findings for the PAS background companion, with precedents and launch requirements."
---

# Native companion: store approval investigation

Researched **2026-11-06**. This is a documented engineering assessment, not approval from either store. Current scope is Android only. Recheck policies at submission.

## Exact product assessed

One consumer native PAS app uses the same account as PAS web apps. Users separately enable supported services for named apps. PAS collects native data, uploads it to the platform, and the platform exposes it only to those authorized apps. Web apps are not hosted inside PAS. Users normally stay in their web apps and visit PAS only for initial connection, permission decisions and settings.

## Assessment

There is a credible approval path for a transparent location companion on both stores. No blanket prohibition was found against this architecture. This is not evidence that an unrestricted service host, every future capability, or every data-sharing purpose would be accepted.

### Google Play

Background location must provide substantial user benefit and be essential to a prominently described core feature. Automatic route recording/location sharing must be PAS's real documented functionality. A generic claim that other apps might need coordinates is not a sufficient product justification.

Provide prominent disclosure before the runtime permission, describe collection while closed and the recipient/use, supply the privacy policy and accurate Data Safety answers, and complete background-location review. A foreground service that behaves like ongoing background location remains subject to the background-location policy; it is not an exemption.

Foreground services must serve core user-facing functionality, be perceptible/stoppable and run only as needed. Location sharing, vehicle tracking, rideshare tracking and geofencing are listed examples. Submit the declaration and a video demonstrating the actual user flow. Automatic operation after explicit enablement must remain visible and controllable; do not implement an invisible general-purpose daemon.

Sources: [background location](https://support.google.com/googleplay/android-developer/answer/9799150), [foreground-service declarations](https://support.google.com/googleplay/android-developer/answer/13392821), [service use](https://support.google.com/googleplay/android-developer/answer/16559646), [sensitive permissions](https://support.google.com/googleplay/android-developer/answer/16558241).

### Apple, for a later iOS implementation

Location is an allowed background purpose (§2.5.4), must relate directly to the app's service (§5.1.5), and needs consent and appropriate collection/sharing controls (§5.1). Minimum functionality (§4.2) creates uncertainty for a nearly empty permissions app. A useful native connection/status/privacy control panel strengthens the product's utility without hosting the recipient apps.

Our interpretation is that §4.7's hosted mini-app category is not the obvious fit for a standalone companion sending data through a backend. Apple has not confirmed that interpretation. Do not claim an exemption from review or try to disguise app hosting as a companion. The native app must also meet ordinary login, account deletion, privacy and distribution requirements.

Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Relevant precedents

- **OwnTracks** is listed on [App Store](https://apps.apple.com/us/app/owntracks/id692424691) and [Google Play](https://play.google.com/store/apps/details?id=org.owntracks.android). Its [documented architecture](https://owntracks.org/booklet/guide/whathow/) publishes background location to a server for downstream use.
- **Home Assistant Companion** documents [background location and per-server sharing controls](https://companion.home-assistant.io/docs/core/location/). Its background sensor/native-capability role is relevant, although it also contains features PAS is not proposing.

These are feasibility precedents, not transferable approvals. Neither establishes that high-frequency tracking, every recipient or every use is acceptable.

## Submission evidence to prepare

- Working consumer account and live backend, named recipient app, reproducible permission flow.
- A video: disclosure → OS permissions → enable Ski → lock phone → observe native notification → reopen Ski with recorded samples → revoke → verify delivery stops.
- Explain automatic recording and its user benefit, accuracy mode, collection duration, offline queue, retention and battery behaviour.
- Show pause all, per-app revocation, disconnect and deletion; disclose offline revocation latency and separately saved app data.
- Finish Google Play declarations, privacy policy, Data Safety, app signing, account-deletion requirements and target-API checks.
- No developer console, arbitrary code loading, covert tracking, advertising use of location or blanket grants to future apps.

No policy found requires opening PAS daily or manually starting every ride. That does not waive background review or permit collection beyond the explicitly enabled automatic feature.

## Runtime acceptance is separate

Approval does not ensure continuous delivery. Test permission revocation, approximate-only access, screen lock, app switch, OS process death, explicit force-stop, restart, no GPS, airplane mode, reconnection, low storage, duplicate uploads, account changes and recipient revocation. Sparse significant-change observations cannot reconstruct a precise ski route. Report gaps and measured accuracy honestly.
