# ProAppStore Android companion

Native **Kotlin + Jetpack Compose + Material 3** app for PAS **app users**. No developer console or web-app container. The platform owns identity, individual app grants and the data plane.

Architecture and delivery status: [platform documentation](../docs/native-companion.md), [ADR-015](../docs/adr/015-native-companion.md), [store research](../docs/native-companion-review.md).

## Build

Prerequisites: JDK 17, Android SDK platform 36 and platform tools. Set `ANDROID_HOME` or create an untracked `local.properties` with `sdk.dir=/path/to/sdk`.

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
# With an emulator/device attached:
./gradlew :app:connectedDebugAndroidTest
```

Debug APK: `app/build/outputs/apk/debug/app-debug.apk`. Package ID: `online.proappstore.companion`. Android 10/API 29 minimum; compile/target API 36. Dependency versions are pinned to a compatible stable SDK-36 toolchain.

## Android deployment

The [release runbook](../docs/native-android-release.md) follows HeartFull's signed AAB → Play upload → fresh track verification model. GitHub Actions builds signed APK/AAB artifacts on Android changes to `main`; Google Play publishing activates after the one-time app setup. Release credentials belong to `ops` project `pas` and repository-level GitHub secrets. Only the public upload certificate is committed.

`version.properties` owns the human version and minimum version code. CI chooses a code above uploaded bundles and every Play track before publishing. Release tasks fail without the upload signing credentials; there is no debug-signing fallback. Backend deployments run independently.

## Initial capabilities

- Existing PAS Google/GitHub account sign-in through the system browser; no credentials entered into a WebView.
- Per-app disclosure and consent, with Ski as the first reviewed integration.
- Native location foreground service and visible Pause all notification.
- Private SQLite offline queue, exact upload acknowledgement, Keystore-protected installation credential.
- Immediate local revoke, queued server revoke, reconnect/upload and device disconnect.
- Consumer UI in Compose, system light/dark theme, explicit status/error states.

Location permission alone does not authorize an app. Each sample captures its recipient grants; the server rechecks them. Revoked grants and old account queues cannot be adopted by a new consent.

## Acceptance before release

The backend/native prototype is not a Play-approved release. Verify on physical Android devices: lock screen, GPS loss, network loss, force-stop, denied/revoked permissions, offline app revocation, regrant, expired credentials, storage failure and multiple recipients. SDK permission handoff, Ski UI consumption, worker delivery, verified App Links, boot recovery and additional capabilities remain follow-ups listed in the platform documentation.

The fixed production API origin is `https://api.proappstore.online`; release code does not expose a server URL or token field to users. The custom return URI contains no credentials and never grants permission. Public App Links will be added with the release certificate.
