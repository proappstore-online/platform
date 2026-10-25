#!/usr/bin/env bash
# Verify that the org-scoped self-hosted runner for the Mac Mini is registered and online (#422).
# Usage: scripts/verify-runner.sh [org] [runner-name]
set -euo pipefail

ORG="${1:-proappstore-online}"
NAME="${2:-pags-sergeys-mac-mini-local}"

row=$(gh api "orgs/${ORG}/actions/runners" --paginate \
  --jq ".runners[] | select(.name == \"${NAME}\") | [.status, ([.labels[].name] | join(\",\"))] | @tsv")

if [ -z "$row" ]; then
  echo "FAIL: runner ${NAME} is not registered to org ${ORG}" >&2
  exit 1
fi

status=${row%%$'\t'*}
labels=${row#*$'\t'}

if [ "$status" != "online" ]; then
  echo "FAIL: runner ${NAME} is ${status}, expected online" >&2
  exit 1
fi

case ",${labels}," in
  *,self-hosted,*,pags,*) ;;
  *) echo "FAIL: runner ${NAME} is missing the self-hosted/pags labels (has: ${labels})" >&2; exit 1 ;;
esac

echo "OK: ${NAME} is online in ${ORG} (labels: ${labels})"
