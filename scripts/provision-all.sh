#!/usr/bin/env bash
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
)

call_provision() {
  local id=$1 name=$2 category=$3 icon=$4 iconBg=$5 description=$6 proFeatures=$7

  # Convert comma-sep proFeatures string → JSON array.
  local proFeaturesJson
  proFeaturesJson=$(printf '%s' "$proFeatures" | python3 -c 'import sys,json; print(json.dumps([x.strip() for x in sys.stdin.read().split(",") if x.strip()]))')

  local body
  body=$(python3 -c "
import json
print(json.dumps({
    'appId': '$id',
    'name': '$name',
    'category': '$category',
    'icon': '$icon',
    'iconBg': '$iconBg',
    'description': '''$description''',
    'proFeatures': $proFeaturesJson,
}))
")

  echo "─── $id ($name) ───"
  curl -sS -X POST "$PAS_API/v1/provision" \
    -H "Authorization: Bearer $FAS_SESSION_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" \
  | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    print(f"  ! parse error: {e}")
    sys.exit(0)
for s in d.get("steps", []):
    icon = {"ok": "+", "skip": "-", "fail": "!"}.get(s["status"], "?")
    print(f"  [{icon}] {s['name']}: {s['detail']}")
if d.get("success"):
    print(f"  ✓ provisioned. URL: https://{d['appId']}.proappstore.online")
else:
    print(f"  ✗ some steps failed")
'
  echo
}

for entry in "${APPS[@]}"; do
  IFS='|' read -r id name category icon iconBg description proFeatures <<< "$entry"
  call_provision "$id" "$name" "$category" "$icon" "$iconBg" "$description" "$proFeatures"
done
