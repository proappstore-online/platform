#!/usr/bin/env bash
# migrate-pages-to-r2.sh — one-time migration of existing PAS app files
# from CF Pages to R2.
#
# For each app, clones the repo, builds, and uploads web/dist/ to R2.
# Requires: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID env vars.
#
# Usage:
#   export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ACCOUNT_ID=...
#   bash packages/host/scripts/migrate-pages-to-r2.sh

set -euo pipefail

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${R2_ACCOUNT_ID:-}" ]; then
  echo "Error: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID must be set"
  exit 1
fi

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
EP="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

ORG="proappstore-online"
BUCKET="pas-apps"
INFRA="admin console dashboard host mcp platform proappstore template-app kbqa-smoke"

APPS=$(gh api "orgs/${ORG}/repos" --jq '.[].name' --paginate | sort)
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

ok=0
fail=0

for app in $APPS; do
  # Skip infra repos
  echo "$INFRA" | tr ' ' '\n' | grep -qx "$app" && continue

  echo "--- $app ---"
  cd "$TMPDIR"
  rm -rf "$app"

  # Clone and build
  if ! gh repo clone "${ORG}/${app}" "$app" -- --depth=1 2>/dev/null; then
    echo "  SKIP: clone failed"
    fail=$((fail + 1))
    continue
  fi
  cd "$app"

  if [ ! -f "pnpm-lock.yaml" ]; then
    echo "  SKIP: no pnpm-lock.yaml"
    fail=$((fail + 1))
    continue
  fi

  pnpm install --frozen-lockfile --silent 2>/dev/null || true
  pnpm build 2>/dev/null || {
    echo "  SKIP: build failed"
    fail=$((fail + 1))
    continue
  }

  if [ ! -d "web/dist" ] || [ -z "$(ls -A web/dist 2>/dev/null)" ]; then
    echo "  SKIP: no build output at web/dist"
    fail=$((fail + 1))
    continue
  fi

  # Upload to R2
  aws s3 sync ./web/dist "s3://${BUCKET}/apps/${app}/" \
    --endpoint-url "$EP" --delete --no-progress 2>/dev/null
  echo "  OK: uploaded to apps/${app}/"
  ok=$((ok + 1))
done

echo ""
echo "Migration complete: $ok uploaded, $fail skipped"
