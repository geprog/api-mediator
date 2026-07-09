#!/usr/bin/env bash
# Seed a fresh OrangeHRM instance with the business-suite fixtures.
#
# OPTIONAL: mapping detection runs on the spec files alone — seed data only
# matters once sync/adapter flows run against live apps. Create-only: run once
# after `docker compose up`; reset with `docker compose down -v`.
#
# API v2 is called with a session cookie (exactly like the web UI does); a
# future mediator would use an OAuth2 client instead (Admin > OAuth in the UI).
# Required env: BASE_URL, OHRM_USER, OHRM_PASS + fixtures.env vars.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
: "${BASE_URL:?}" "${OHRM_USER:?}" "${OHRM_PASS:?}"

JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
CSRF=$(curl -fsS -c "$JAR" -L "$BASE_URL/web/index.php/auth/login" \
  | grep -oE ':token="&quot;[^&]+&quot;"' | sed 's/.*&quot;\(.*\)&quot;.*/\1/')
curl -fsS -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE_URL/web/index.php/auth/validate" \
  --data-urlencode "_token=$CSRF" \
  --data-urlencode "username=$OHRM_USER" --data-urlencode "password=$OHRM_PASS"

api() { curl -fsS -X "$1" -b "$JAR" "$BASE_URL/web/index.php/api/v2$2" \
         -H 'Content-Type: application/json' ${3:+--data "$3"}; }

ALICE=$(api POST /pim/employees "{\"firstName\":\"$ALICE_FIRST\",\"middleName\":\"\",\"lastName\":\"$ALICE_LAST\",\"employeeId\":\"0002\"}" | jq '.data.empNumber')
BOB=$(api POST /pim/employees "{\"firstName\":\"$BOB_FIRST\",\"middleName\":\"\",\"lastName\":\"$BOB_LAST\",\"employeeId\":\"0003\"}" | jq '.data.empNumber')

# Work emails are the cross-app identity key (same address in every app).
# Note the singular "employee" — unlike every other PIM route.
api PUT "/pim/employee/$ALICE/contact-details" "{\"workEmail\":\"$ALICE_EMAIL\"}" >/dev/null
api PUT "/pim/employee/$BOB/contact-details" "{\"workEmail\":\"$BOB_EMAIL\"}" >/dev/null

log "seeded $BASE_URL"
