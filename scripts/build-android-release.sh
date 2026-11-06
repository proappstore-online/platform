#!/usr/bin/env bash
# CI signing consumer: restore only into its private temporary directory; remove on every exit.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for name in ANDROID_UPLOAD_KEYSTORE_BASE64 ANDROID_UPLOAD_KEYSTORE_PASSWORD ANDROID_UPLOAD_KEY_ALIAS ANDROID_UPLOAD_KEY_PASSWORD ANDROID_BUILD_NUMBER; do
  if [[ -z "${!name:-}" ]]; then echo "Missing release configuration: $name" >&2; exit 1; fi
done
[[ "$ANDROID_BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] && (( ANDROID_BUILD_NUMBER <= 2100000000 )) || { echo 'Invalid ANDROID_BUILD_NUMBER' >&2; exit 1; }
signing_tmp="$(mktemp -d)"
trap 'rm -rf "$signing_tmp"' EXIT
export ANDROID_UPLOAD_KEYSTORE_PATH="$signing_tmp/upload.p12"
printf '%s' "$ANDROID_UPLOAD_KEYSTORE_BASE64" | base64 --decode > "$ANDROID_UPLOAD_KEYSTORE_PATH"
expected="$(openssl x509 -in "$ROOT/android/signing/upload-certificate.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"
keytool -exportcert -rfc -keystore "$ANDROID_UPLOAD_KEYSTORE_PATH" -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD -alias "$ANDROID_UPLOAD_KEY_ALIAS" > "$signing_tmp/certificate.pem"
actual="$(openssl x509 -in "$signing_tmp/certificate.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"
[[ -n "$expected" && "$actual" == "$expected" ]] || { echo 'PAS upload certificate does not match the pinned certificate.' >&2; exit 1; }
cd "$ROOT/android"
./gradlew --no-daemon :app:assembleRelease :app:bundleRelease :app:lintRelease
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "$sdk_root" ]] || { echo 'ANDROID_HOME is required for signature verification.' >&2; exit 1; }
apksigner="$(find "$sdk_root/build-tools" -name apksigner -type f | sort | tail -n 1)"
[[ -x "$apksigner" ]] || { echo 'Android apksigner is missing.' >&2; exit 1; }
"$apksigner" verify --verbose --print-certs app/build/outputs/apk/release/app-release.apk > "$signing_tmp/apk-signature.txt"
grep -Fq "$expected" "$signing_tmp/apk-signature.txt" || { echo 'APK signer differs from the PAS upload certificate.' >&2; exit 1; }
jarsigner -verify app/build/outputs/bundle/release/app-release.aab > "$signing_tmp/bundle-signature.txt"
grep -q 'jar verified' "$signing_tmp/bundle-signature.txt" || { echo 'AAB signature verification failed.' >&2; exit 1; }
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab -rfc > "$signing_tmp/bundle-certificate.pem"
bundle_signer="$(openssl x509 -in "$signing_tmp/bundle-certificate.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"
[[ "$bundle_signer" == "$expected" ]] || { echo 'AAB signer differs from the PAS upload certificate.' >&2; exit 1; }
node --input-type=module - <<'JS'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const paths = ['app/build/outputs/apk/release/app-release.apk', 'app/build/outputs/bundle/release/app-release.aab', 'app/build/outputs/mapping/release/mapping.txt'];
mkdirSync('app/build/outputs/release', { recursive: true });
writeFileSync('app/build/outputs/release/release.json', JSON.stringify({ packageName: 'online.proappstore.companion', versionCode: Number(process.env.ANDROID_BUILD_NUMBER), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), artifacts: paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) }, null, 2));
JS
echo "Verified signed PAS APK and AAB: versionCode=$ANDROID_BUILD_NUMBER"
