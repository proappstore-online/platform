#!/usr/bin/env bash
# Sync all Worker secrets from Doppler (source of truth) to Cloudflare Workers.
#
# Doppler auto-syncs to GitHub org secrets (for CI), but Worker secrets are
# separate — they must be set via `wrangler secret put`. This script ensures
# all three PAS Workers have the same INTERNAL_TOKEN (and any other shared
# secrets) so service-to-service auth doesn't break.
#
# Usage: ./scripts/sync-worker-secrets.sh
# Requires: doppler CLI (authenticated), wrangler CLI, CLOUDFLARE_API_TOKEN in env or Doppler.

set -euo pipefail

PROJECT="pas"
CONFIG="prd"

# Workers that need INTERNAL_TOKEN
WORKERS=(
  "proappstore-api"
  "proappstore-agent-teams"
  "proappstore-admin"
)

# Get the CF API token for wrangler
export CLOUDFLARE_API_TOKEN
CLOUDFLARE_API_TOKEN=$(doppler secrets get CLOUDFLARE_API_TOKEN --project "$PROJECT" --config "$CONFIG" --plain)

echo "Syncing secrets from Doppler ($PROJECT/$CONFIG) to Workers..."
echo ""

# INTERNAL_TOKEN — shared across all three Workers
INTERNAL_TOKEN=$(doppler secrets get INTERNAL_TOKEN --project "$PROJECT" --config "$CONFIG" --plain)
for worker in "${WORKERS[@]}"; do
  echo -n "  $worker/INTERNAL_TOKEN... "
  echo "$INTERNAL_TOKEN" | npx wrangler secret put INTERNAL_TOKEN --name "$worker" 2>/dev/null && echo "✓" || echo "✗"
done

# GH_ADMIN_TOKEN — only on admin
echo ""
GH_ADMIN_TOKEN=$(doppler secrets get GH_ADMIN_TOKEN --project "$PROJECT" --config "$CONFIG" --plain)
echo -n "  proappstore-admin/GH_ADMIN_TOKEN... "
echo "$GH_ADMIN_TOKEN" | npx wrangler secret put GH_ADMIN_TOKEN --name proappstore-admin 2>/dev/null && echo "✓" || echo "✗"

# APP_SECRET_KEK — only on backend (key vault encryption)
APP_SECRET_KEK=$(doppler secrets get APP_SECRET_KEK --project "$PROJECT" --config "$CONFIG" --plain 2>/dev/null || echo "")
if [ -n "$APP_SECRET_KEK" ]; then
  echo -n "  proappstore-api/APP_SECRET_KEK... "
  echo "$APP_SECRET_KEK" | npx wrangler secret put APP_SECRET_KEK --name proappstore-api 2>/dev/null && echo "✓" || echo "✗"
fi

echo ""
echo "Done. All Workers synced."
