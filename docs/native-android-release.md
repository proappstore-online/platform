---
description: "Signed PAS Android builds, Google Play publishing, credential ownership, versioning and first-release setup."
---

# Android release runbook

PAS uses HeartFull's current release model: test → signed Android App Bundle → Google Play upload → commit → verify the requested version and status through a fresh Play edit. The implementation stays in the PAS platform monorepo and uses native Gradle/Kotlin builds. HeartFull's Flutter/Firebase configuration and credentials are not shared.

## Current delivery state

The native companion is an early preview. Signing and release automation are configured, with dedicated PAS credentials. Google Play app registration, publisher permission, initial Console upload and policy declarations must be completed before Play automation can be enabled. A signed artifact is not a Play release; track acceptance is not Google review approval or proof of store availability.

The Play package (`applicationId`) is **`online.proappstore.app`**: `online.proappstore.companion` is taken on Google Play (#684). The Kotlin package and `namespace` stay `online.proappstore.companion`; iOS keeps that bundle ID. Do not register a different package or replace the upload key after the first upload. The initial native implementation and pending Ski integration are described in [Native companion](./native-companion.md).

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

The owner's steps, values and order are tracked in #666. This is the pipeline's part.

1. The app exists in the OpenFrontier.One Play developer account, package `online.proappstore.app` (Play app id 4975081324229106561), with Play App Signing. If Play has no bundle yet, upload the first `app-release.aab` by hand, from a workflow artifact: the Publishing API cannot make the first upload of a new app. The committed certificate identifies the **upload** key; Google's app-signing certificate may differ.
2. Give `pas-play-publisher@proappstore-online.iam.gserviceaccount.com` access to this app only: view app information and release to testing tracks (production releases later). Then `gh workflow run android.yml --repo proappstore-online/platform --ref main -f publish=true -f track=internal -f status=draft` must succeed and read its track back. If Play reports `internal` as unknown, use the internal track name the error lists. A draft app accepts only `draft` releases until its first review.
3. Complete App content (#666).
4. Closed testing is optional for this account: it is a personal account created before 13 November 2023, so Play does not require a closed test before production access (#661). To use one anyway, create the track in Console, then `-f track=<its name> -f status=completed`.
5. Automatic testing releases (optional): set `ANDROID_PLAY_PUBLISH_ENABLED=true` and `ANDROID_PLAY_TRACK=<testing track>`. Unset, automatic publishing targets `internal`. A push never publishes to `production`: with `ANDROID_PLAY_TRACK=production` the release job fails before building.
6. Production is a manual release: `gh workflow run android.yml --repo proappstore-online/platform --ref main -f publish=true -f track=production -f status=completed`, after App content is complete and an internal build has been checked on a device (#666). Play then reviews it.

The publisher validates the track against the app's real track list before uploading, and refuses an unknown one with the names Play reports.

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
