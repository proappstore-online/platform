---
description: "Signed PAS Android builds, Google Play publishing, credential ownership, versioning and first-release setup."
---

# Android release runbook

PAS uses HeartFull's current release model: test → signed Android App Bundle → Google Play upload → commit → verify the requested version and status through a fresh Play edit. The implementation stays in the PAS platform monorepo and uses native Gradle/Kotlin builds. HeartFull's Flutter/Firebase configuration and credentials are not shared.

## Current delivery state

The native companion is an early preview. Signing and release automation are configured, with dedicated PAS credentials. Google Play app registration, publisher permission, initial Console upload and policy declarations must be completed before Play automation can be enabled. A signed artifact is not a Play release; track acceptance is not Google review approval or proof of store availability.

The package is **`online.proappstore.companion`**. Do not register a different package or replace the upload key after the first upload. The initial native implementation and pending Ski integration are described in [Native companion](./native-companion.md).

## Routine delivery

Push Android changes to `main`. `.github/workflows/android.yml` runs build, unit tests and lint, then a separate trusted release job builds signed APK and AAB files. Pull requests receive no signing or Play credentials. All jobs use the PAS runner router. Release runs are serialized and never cancel a publishing job midway.

The release artifact includes:

- `app-release.aab` for Google Play.
- `app-release.apk` for direct installation, signed with the stable PAS upload key.
- R8 `mapping.txt`, retained for crash deobfuscation.
- `release.json` with source commit, version code and artifact checksums.
- The public upload certificate.

The workflow verifies both signatures against `android/signing/upload-certificate.pem` before upload. Missing credentials or a mismatched certificate fail the release; unsigned/debug-signed output is never substituted.

Direct APKs use the upload certificate. Play-distributed installs use the Play app-signing certificate. If those certificates differ, switching between direct and Play installs requires uninstalling first; use Play testing tracks for testers who need continuous upgrades.

`android/version.properties` owns `versionName` and the minimum `versionCode`. Artifact builds use at least the workflow run number. Play uploads use a code above **all tracks, uploaded bundles and APKs**, avoiding the production-only version collision in HeartFull's older helper. API failures do not fall back to a guessed code. An existing staged rollout must be resolved before the publisher replaces that track.

## First Play Console setup

1. Create ProAppStore in the intended Google Play developer account. Use the signed AAB from the workflow to establish `online.proappstore.companion` and configure Play App Signing. The committed certificate identifies the **upload** key; Google's app-signing certificate may differ.
2. Grant **`pas-play-publisher@proappstore-online.iam.gserviceaccount.com`** access to this app only: app information, testing-track releases, and production releases when ready. No account-wide or HeartFull access is needed. No extra GCP project role is needed for publishing.
3. Complete the actual privacy policy, app access/reviewer instructions, Data Safety, content rating, background-location and foreground-service declarations, and required listing assets. Use the [policy research](./native-companion-review.md); do not claim Ski web/worker integration or physical-device acceptance is finished.
4. Complete the initial Console upload/setup needed for API access. Start with the appropriate testing track; the workflow supports an explicit `internal` / `draft` upload. A draft app may reject completed releases until Console setup is finished.
5. Once the publisher can read the package and the product is ready, enable automatic publishing with repository variable `ANDROID_PLAY_PUBLISH_ENABLED=true`. `ANDROID_PLAY_TRACK=production` matches HeartFull's routine destination; use `internal` for testing. Automatic releases request `completed` status, so keep automation off while the app must remain draft.

Build signed artifacts without publishing:

```sh
gh workflow run android.yml --repo proappstore-online/platform --ref main
```

Explicit initial testing upload after Console setup:

```sh
gh workflow run android.yml --repo proappstore-online/platform --ref main \
  -f publish=true -f track=internal -f status=draft
```

The release job only runs from `main`. Backend deployment is independent: Play setup or review must not prevent platform services from deploying.

## Credentials and recovery

Source of truth: `~/dev/ops`, project `pas`, audit trail [ops#46](https://github.com/serge-ivo/ops/issues/46). Repository-level secrets:

| Secret | Purpose |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | Dedicated PAS PKCS12 upload key |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Store password |
| `ANDROID_UPLOAD_KEY_ALIAS` | Upload alias |
| `ANDROID_UPLOAD_KEY_PASSWORD` | Private-key password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Dedicated PAS publisher identity |

Use `ops` to rotate/place values. Never use org secrets or copy HeartFull's key. CI restores the keystore into a private temporary directory and removes it on exit. Credential values never enter release metadata, artifacts or logs.

On failure, inspect the failed step: signing, build, upload, validation, commit or track verification. The pipeline discards uncommitted edits and reports errors instead of claiming success. Re-run a failed workflow on the same source only after diagnosing the cause; publishing chooses a fresh code. After a successful commit but failed read-back, inspect the track before retrying. Report the accepted package, version, track and status separately from store review/availability.

Codemagic is HeartFull's independent fallback, but PAS has no Codemagic app/signing setup. The manual GitHub workflow is the PAS recovery path; do not imply a second provider is configured.

Google references: [API setup](https://developers.google.com/android-publisher/getting_started), [track release statuses](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks), [Android signing keys](https://developer.android.com/studio/publish/app-signing).
