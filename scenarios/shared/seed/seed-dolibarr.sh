#!/usr/bin/env bash
# Seed a fresh Dolibarr instance with the business-suite fixtures.
#
# OPTIONAL: mapping detection runs on the spec files alone — seed data only
# matters once sync/adapter flows run against live apps. Create-only: run once
# after `docker compose up`; reset with `docker compose down -v`.
#
# Required env: BASE_URL, TOKEN (DOLAPIKEY) + fixtures.env vars.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
: "${BASE_URL:?}" "${TOKEN:?}"

api() { curl -fsS -X "$1" "$BASE_URL/api/index.php$2" -H "DOLAPIKEY: $TOKEN" \
         -H 'Content-Type: application/json' ${3:+--data "$3"}; }

api POST /users "{\"login\":\"$ALICE_USER\",\"firstname\":\"$ALICE_FIRST\",\"lastname\":\"$ALICE_LAST\",\"email\":\"$ALICE_EMAIL\",\"password\":\"$ALICE_PASS\"}" >/dev/null
api POST /users "{\"login\":\"$BOB_USER\",\"firstname\":\"$BOB_FIRST\",\"lastname\":\"$BOB_LAST\",\"email\":\"$BOB_EMAIL\",\"password\":\"$BOB_PASS\"}" >/dev/null

CUSTOMER=$(api POST /thirdparties "{\"name\":\"$CUSTOMER_NAME\",\"client\":1,\"code_client\":\"auto\"}")
PROJECT=$(api POST /projects "{\"ref\":\"PJ-PHOENIX\",\"title\":\"$S5_PROJECT_NAME\",\"socid\":$CUSTOMER}")
TASK=$(api POST /tasks "{\"ref\":\"TK-PHOENIX-1\",\"label\":\"$S5_PROJECT_NAME implementation\",\"fk_project\":$PROJECT}")

# NOT seeded: time spent on the task (the counterpart of a Kimai timesheet).
# POST /tasks/{id}/addtimespent is broken in Dolibarr 23.0.3 — the Restler
# validator fatals ("Illegal offset type", Validator.php:427) for JSON and
# form bodies alike. The operation still exists in the spec, so the
# time-entry pair remains valid detection ground truth; live sync tests for
# it need a fixed Dolibarr first.
log "skipping time-spent entry (task $TASK): POST /tasks/{id}/addtimespent broken upstream in 23.0.3"

# One unpaid draft invoice — deliberately without counterpart in Kimai/OrangeHRM.
api POST /invoices "{\"socid\":$CUSTOMER,\"type\":0}" >/dev/null

log "seeded $BASE_URL"
