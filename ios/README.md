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

Device installs are signed in Xcode with your own team. `DEVELOPMENT_TEAM` is never committed: set it in Signing & Capabilities or in an untracked `Config/Local.xcconfig` (which may also override `PAS_BUNDLE_ID`). Distribution is developer installation only; there is no TestFlight or App Store build.

The fixed production API origin is `https://api.proappstore.online`; the app exposes no server URL or token field. The `proappstore://native/…` return URI contains no credentials and never grants permission.
