# App Store listing: ProAppStore (iOS)

App Store Connect app **6838534784**, bundle `online.proappstore.companion`, version 1.0 page. Paste each field as is.
Proposed in #685 item 6. Reuses the Play listing text (#665) where it is true on iOS.

**Wording rules (#661 decision 2):** the app is a companion for ProAppStore web apps. Never call it an "app store",
in any field. **Describe this build only:** today's iOS build collects while an app is turned on and not paused
(Pause, Pause all), not in user-started sessions. If #685 item 4 moves iOS to ADR-020 sessions, replace the second
paragraph and the third bullet with the Play text in `android/play/listing.md` (Start, Stop, 30 minutes, 12 hours)
in the same release.

Already set in App Information (not repeated here): name **ProAppStore**, subtitle **Phone companion for PAS apps**,
category Health & Fitness / Utilities, age rating 18+.

## Promotional text (148 / 170 characters)

```
Record runs, ski days and drives for your ProAppStore apps, even with your phone locked. You choose each app, and you can pause sharing at any time.
```

## Description

```
ProAppStore keeps your ProAppStore web apps working while your phone is locked.

Turn on Run, Ski or Rideshare in ProAppStore, then put your phone away. While an app is on, ProAppStore records your location with the screen locked and sends it only to the apps you chose, so your route is complete when you open the app again. Run can also receive your heart rate from a Bluetooth heart-rate strap you choose.

• You choose each app. Each one explains what it receives before you turn it on.
• See what each app received today, what is waiting to upload, and a 30-day history that stays on your phone.
• Pause one app or all of them at any time, or turn an app off.
• Disconnect your phone to delete its data from ProAppStore. Settings → Delete account explains how to delete your account.
• Browse ProAppStore apps and open them in your browser.

Your location is never sold or used for advertising. ProAppStore deletes its copies of your location after 7 days.

Sign in with the Google or GitHub account you use in your ProAppStore apps.
```

## Keywords (98 / 100 characters)

```
run tracker,route recorder,gps,ski,rideshare,location sharing,heart rate,workout,walking,companion
```

## URLs

| Field | Value |
|---|---|
| Support URL | `https://docs.proappstore.online/native-companion-users/` |
| Marketing URL | `https://proappstore.online` |
| Privacy policy URL | `https://proappstore.online/privacy` (already set in App Privacy) |

## Screenshots (6.9" iPhone, 1320 × 2868)

`screenshots/` in this directory, rendered from fixture data by `ProAppStoreTests/ScreenshotTests.swift` on an
iPhone 16 Pro Max simulator (fictional account "Alex Example", a synthetic walk; no real names, emails or tracks).
Upload in this order: `1-sharing.png`, `2-run-detail.png`, `3-storefront.png`, `4-activity.png`, `5-settings.png`.

Regenerate (the permission grant and a fixed simulated position make the dashboard show "Location sharing is on"
instead of "Location permission needed"; the position is the fixture walk's start, not anyone's location):

```sh
xcrun simctl privacy <udid> grant location-always online.proappstore.companion
xcrun simctl location <udid> set 37.3349,-122.009
TEST_RUNNER_PAS_SCREENSHOTS=/tmp/shots xcodebuild -project ios/ProAppStore.xcodeproj -scheme ProAppStore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro Max' test CODE_SIGN_IDENTITY=- \
  -only-testing:ProAppStoreTests/ScreenshotTests
```

then copy the light 1320 × 2868 captures (`sharing-light.png`, `run-detail-light.png`, `storefront-light.png`,
`activity-light.png`, `settings-light.png`) here under the names above, flattened to RGB on white: App Store
Connect rejects screenshots with an alpha channel, and the captures have one.
