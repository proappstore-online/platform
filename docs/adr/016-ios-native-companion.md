---
description: "iOS client for the PAS native companion: Swift/SwiftUI in ios/, same server protocol and consent model as ADR-015."
---

# ADR-016: iOS native companion

## Status

Accepted. Extends ADR-015; does not supersede it. Decision 4's optional "Always" restart upgrade is superseded by [ADR-020](./020-native-collection-sessions.md) §8: iOS asks for While Using only and collects only in user-started sessions.

## Date

2026-11-23

## Context

ADR-015 placed the native companion in `android/` as a Kotlin app. PAS web apps on iPhone have the same limit: Safari suspends page JavaScript when the phone locks, so Run and Ski cannot record a route with the screen off. The `/v1/native/*` protocol is OS-neutral: device labels are free text and no table records a platform.

## Decision

1. Keep the iOS project in the platform repository at `ios/`, beside `android/`. Use **Swift and SwiftUI** with Core Location, the Keychain and the system SQLite library. No WebView, React Native, Flutter or third-party packages.
2. iOS uses the ADR-015 protocol unchanged: browser pairing through `ASWebAuthenticationSession`, a device-proof single-use exchange, a narrow `ndev_` credential, per-app grants, idempotent upload and app-bound reads. No iOS-specific server route, column or credential type.
3. The credential is stored in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and the queue with `completeUntilFirstUserAuthentication`. Both are readable while locked so that upload can continue, and neither leaves the device in backups or migration.
4. Background collection uses `allowsBackgroundLocationUpdates` with the visible location indicator. "While Using" permission suffices for a session started in the foreground. "Always" is an optional, separately explained upgrade that only allows restart after the OS terminates the app. Reduced accuracy never becomes route tracking.
5. Distribution in this phase is **direct developer installation from Xcode only**. No TestFlight, App Store submission or Apple review is implied by this ADR; `docs/native-companion-review.md` governs that later.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Kotlin Multiplatform / shared core with Android | Adds a toolchain to both apps for ~300 lines of shared policy; the duplication is small and readable. |
| Capacitor or a WebView wrapper around the web apps | ADR-015 rejects app containers; also does not change Safari's lock-screen suspension rules for the web content. |
| Web-only (wake lock, silent audio) | Rejected in ADR-015; not a supported background mode. |
| Require "Always" like Android requires background permission | Unnecessary on iOS for a foreground-started session; asking for more than needed weakens consent and review posture. |

## Consequences

**Positive:**
- One PAS account and grant model on both phone platforms; recipient apps read one stream regardless of OS.

**Negative:**
- Two native codebases to keep behaviourally equal; the Android client is the reference and divergences must be written down (the iOS batch-freshness rule is one).
- Developer-installed builds on a free Apple team expire after 7 days and must be re-run from Xcode.

**Neutral:**
- iOS may still terminate the app or withhold accurate fixes. As in ADR-015, a gap remains a gap.
