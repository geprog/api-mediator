#!/usr/bin/env bash
# Seed a fresh Kimai instance with the business-suite fixtures.
#
# OPTIONAL: mapping detection runs on the spec files alone — seed data only
# matters once sync/adapter flows run against live apps. Create-only: run once
# after `docker compose up`; reset with `docker compose down -v`.
#
# Required env: BASE_URL, TOKEN (Bearer) + fixtures.env vars.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
: "${BASE_URL:?}" "${TOKEN:?}"

api() { curl -fsS -X "$1" "$BASE_URL/api$2" -H "Authorization: Bearer $TOKEN" \
         -H 'Content-Type: application/json' ${3:+--data "$3"}; }

api POST /users "{\"username\":\"$ALICE_USER\",\"alias\":\"$ALICE_FIRST $ALICE_LAST\",\"email\":\"$ALICE_EMAIL\",\"plainPassword\":\"$ALICE_PASS\",\"language\":\"en\",\"locale\":\"en\",\"timezone\":\"Europe/Berlin\",\"enabled\":true}" >/dev/null
api POST /users "{\"username\":\"$BOB_USER\",\"alias\":\"$BOB_FIRST $BOB_LAST\",\"email\":\"$BOB_EMAIL\",\"plainPassword\":\"$BOB_PASS\",\"language\":\"en\",\"locale\":\"en\",\"timezone\":\"Europe/Berlin\",\"enabled\":true}" >/dev/null

# visible/billable must be sent explicitly: the API form treats a missing
# checkbox as false, and invisible customers can't be referenced by projects.
CUSTOMER=$(api POST /customers "{\"name\":\"$CUSTOMER_NAME\",\"country\":\"DE\",\"currency\":\"EUR\",\"timezone\":\"Europe/Berlin\",\"visible\":true,\"billable\":true}" | jq .id)
PROJECT=$(api POST /projects "{\"name\":\"$S5_PROJECT_NAME\",\"customer\":$CUSTOMER,\"visible\":true,\"billable\":true,\"globalActivities\":true}" | jq .id)
ACTIVITY=$(api POST /activities "{\"name\":\"$KIMAI_ACTIVITY_NAME\",\"visible\":true,\"billable\":true}" | jq .id)

# The counterpart of Dolibarr's task time-spent entry (same day, same project name).
api POST /timesheets "{\"begin\":\"${TIME_ENTRY_BEGIN%Z}\",\"end\":\"${TIME_ENTRY_END%Z}\",\"project\":$PROJECT,\"activity\":$ACTIVITY,\"description\":\"Worked on $S5_PROJECT_NAME\"}" >/dev/null

log "seeded $BASE_URL"
