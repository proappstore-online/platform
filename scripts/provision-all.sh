#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LEGACY — do not use to provision apps (#132). Kept for reference only.
#
# To create and provision a PAS app, use the ProAppStore MCP server from an
# owner-authenticated session:
#   - tool `provision_pas_app` — repo from an approved template, deploy
#     variables, route + D1 + data worker, verification. Call it with
#     dry_run: true, review the plan, then confirm: true.
#   - skill `create-proappstore-app` (skills/create-proappstore-app/) — the
#     operator playbook that drives that flow end to end.
# Re-provision an existing app with `provision_app` (dry_run, then confirm).
# See docs/provisioning-operator.md.
#
# Why not this script: it needs a pasted human session token
# (FAS_SESSION_TOKEN), its prerequisites below (fas/admin zone id, wrangler
# deploys) no longer apply, and its hard-coded APPS array is not a source of
# truth for app definitions (the apps / app_listings tables and each app's repo
# are).
# ─────────────────────────────────────────────────────────────────────────────
#
# Provision (or re-provision, idempotently) all real PAS apps via the new
# delegated provisioner. Run this AFTER:
#
#   1. Look up the proappstore.online zone id and set it on fas/admin:
#        ZONE=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
#          "https://api.cloudflare.com/client/v4/zones?name=proappstore.online" \
#          | jq -r '.result[0].id')
#        # Edit fas/admin/wrangler.toml: PAS_ZONE_ID = "$ZONE"
#      Then `cd fas/admin && wrangler deploy`.
#
#   2. Deploy PAS backend so the [[services]] binding takes effect:
#        cd pas/platform/packages/backend && wrangler deploy
#
#   3. Have a FAS session token (export FAS_SESSION_TOKEN=...).
#
# The provision endpoint is idempotent: every step checks existence first,
# so re-running for already-live apps just emits 'skip' lines.

set -u
PAS_API="${PAS_API:-https://api.proappstore.online}"

if [[ -z "${FAS_SESSION_TOKEN:-}" ]]; then
  echo "Error: FAS_SESSION_TOKEN env var not set." >&2
  exit 1
fi

# id|name|category|icon-html-entity|iconBg|description|proFeatures (comma-sep)
APPS=(
  "meetup|Meetup|social|&#128197;|#f5f3ff|Create events, groups, and real-time chat.|Create events,Event chat,Manage groups"
  "dating|Dating|social|&#10084;|#fff1f2|Swipe-style dating with real-time chat when both like each other.|Profile photos,Real-time chat,Mutual-match detection"
  "loopride|Loopride|transport|&#128260;|#ecfdf5|Recurring rides — set route once, driver shows up every week.|Recurring schedule,Live GPS tracking,Driver communication"
  "studio|Studio|productivity|&#127908;|#fffaf0|Multi-tenant studio booking — Mindbody/Momence-shaped product on PAS.|Bookings,Class schedules,Member management"
  "bandmates|Bandmates|social|&#127928;|#fef3c7|Find musicians, manage bands, discover events.|Musician discovery,Band management,Real-time chat,Event RSVP"
)

call_provision() {
  local id=$1 name=$2 category=$3 icon=$4 iconBg=$5 description=$6 proFeatures=$7

  # Build the JSON body in python (where escaping is sane) instead of via
  # bash string interpolation, which has bitten us with apostrophes and
  # commas in descriptions.
  local body
  body=$(
    APP_ID="$id" \
    APP_NAME="$name" \
    APP_CATEGORY="$category" \
    APP_ICON="$icon" \
    APP_ICON_BG="$iconBg" \
    APP_DESCRIPTION="$description" \
    APP_PRO_FEATURES="$proFeatures" \
    python3 -c '
import json, os
features = [f.strip() for f in os.environ["APP_PRO_FEATURES"].split(",") if f.strip()]
print(json.dumps({
    "appId": os.environ["APP_ID"],
    "name": os.environ["APP_NAME"],
    "category": os.environ["APP_CATEGORY"],
    "icon": os.environ["APP_ICON"],
    "iconBg": os.environ["APP_ICON_BG"],
    "description": os.environ["APP_DESCRIPTION"],
    "proFeatures": features,
}))
'
  )

  echo "─── $id ($name) ───"
  curl -sS -X POST "$PAS_API/v1/provision" \
    -H "Authorization: Bearer $FAS_SESSION_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" \
  | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception as e:
    print("  ! parse error:", e, "body:", raw[:200])
    sys.exit(0)
if "steps" not in d:
    print("  ! response:", d)
    sys.exit(0)
for s in d.get("steps", []):
    icon = {"ok": "+", "skip": "-", "fail": "!"}.get(s["status"], "?")
    print("  [" + icon + "] " + s["name"] + ": " + s["detail"])
if d.get("success"):
    print("  ✓ provisioned. URL: https://" + d["appId"] + ".proappstore.online")
else:
    print("  ✗ some steps failed")
'
  echo
}

for entry in "${APPS[@]}"; do
  IFS='|' read -r id name category icon iconBg description proFeatures <<< "$entry"
  call_provision "$id" "$name" "$category" "$icon" "$iconBg" "$description" "$proFeatures"
done
