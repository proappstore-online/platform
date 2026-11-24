# ProAppStore iOS companion

Native **Swift + SwiftUI** app for PAS **app users**, the iOS counterpart of the [Android companion](../android/README.md). No developer console or web-app container. The platform owns identity, individual app grants and the data plane.

Architecture and delivery status: [platform documentation](../docs/native-companion.md), [ADR-015](../docs/adr/015-native-companion.md), [ADR-016](../docs/adr/016-ios-native-companion.md), [store research](../docs/native-companion-review.md).

## Build

Prerequisites: Xcode 16 or later. [XcodeGen](https://github.com/yonaskolb/XcodeGen) **2.45.4** (the version `.github/workflows/ios.yml` pins; others generate different output) only when `project.yml` changes; the generated `ProAppStore.xcodeproj` is committed.

```sh
cd ios && xcodegen generate && git diff --exit-code -- ProAppStore.xcodeproj   # project matches project.yml
cd ..
xcodebuild -project ios/ProAppStore.xcodeproj -scheme ProAppStore -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath build/ios test CODE_SIGN_IDENTITY=-
xcodebuild -project ios/ProAppStore.xcodeproj -scheme ProAppStore -destination 'generic/platform=iOS' -derivedDataPath build/ios build CODE_SIGNING_ALLOWED=NO
```

Tests are ad-hoc signed (`CODE_SIGN_IDENTITY=-`) because an unsigned simulator host has no Keychain access. The device build is unsigned.

Bundle ID: `online.proappstore.companion` (`PAS_BUNDLE_ID` in `Config/Base.xcconfig`). iOS 17 minimum, Swift 5 language mode. No third-party packages.

Device installs are signed in Xcode with your own team. `DEVELOPMENT_TEAM` is never committed: set it in Signing & Capabilities or in an untracked `Config/Local.xcconfig` (which may also override `PAS_BUNDLE_ID`). TestFlight builds come only from CI (#685): the `testflight` job in `.github/workflows/ios.yml` archives `main` with the newest stable Xcode (26 or later; App Store Connect requires the iOS 26 SDK), signs it with the Apple Distribution certificate and App Store profile held in repository secrets, and uploads it to App Store Connect app 6838534784. It runs only when dispatched: `gh workflow run ios.yml --repo proappstore-online/platform --ref main -f testflight=true`. It never runs on a push, never submits for review, and fails at its first step, naming each missing secret, until all six exist (`IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_APPSTORE_PROFILE_BASE64`, `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_API_KEY_P8_BASE64`; held in ops under `pas`).

## Version and branding

`Config/Version.xcconfig` is the only version source: `MARKETING_VERSION` (must equal `versionName` in `android/version.properties`; `test/ios-version.test.ts` fails on drift), `CURRENT_PROJECT_VERSION` and `PAS_COMMIT`. `Info.plist` reads all three; CI passes the workflow run number as the build number and the short SHA as the commit, local builds show build `1` and commit `dev`. The About section displays them.

`Assets.xcassets` holds the app icon, `AccentColor` (the app tint, kit accent `#7c3aed` / dark `#a78bfa`) and `LaunchBackground` (design-system `--paper`, `#f8fafc` / `#0f172a`). `AppIcon-1024.png` is the brand kit's maskable icon composition (the one behind `icon-512.png`) rendered at 1024×1024 with the kit's own `generate.py` and flattened to RGB, because App Store icons must have no alpha channel. Never redraw it: regenerate from the kit and keep its entry in the workspace `brand/destinations.json` (`renders`).

## Storefront

The **Storefront** tab (ADR-017) is a browse-only native store over the public `https://proappstore.online/catalogue.json`. It is fetched by `PublicFetch`, a credential-free client (no `Authorization`, no cookies, no redirects), never by `PasApi`. The file is cached in `Application Support/pas-catalogue/` (outside `pas-native/`, so pairing and disconnect keep it) and revalidated with `If-None-Match` when the app becomes active. Icons and hero images are cached in `Caches/pas-images/`, with the catalogue's emoji on `iconBg` as the placeholder. Open hands the app URL to the browser.

The fixed production API origin is `https://api.proappstore.online`; the app exposes no server URL or token field. The `proappstore://native/…` return URI contains no credentials and never grants permission.
