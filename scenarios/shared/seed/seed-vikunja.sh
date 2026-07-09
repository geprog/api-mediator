#!/usr/bin/env bash
# Seed a fresh Vikunja instance with the shared fixtures.
#
# OPTIONAL: mapping detection runs on the spec files alone — seed data only
# matters once sync/adapter flows run against live apps. Create-only: run once
# after `docker compose up`; reset with `docker compose down -v`.
#
# Required env: BASE_URL, VIKUNJA_USER, VIKUNJA_PASS (2.x JWTs are short-lived,
# so we log in fresh) + fixtures.env vars (caller exports).
# Optional env: UNIQUE_TITLE — app-unique work item for honest non-overlap.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
: "${BASE_URL:?}" "${VIKUNJA_USER:?}" "${VIKUNJA_PASS:?}"

curl -fsS -X POST "$BASE_URL/api/v1/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ALICE_USER\",\"email\":\"$ALICE_EMAIL\",\"password\":\"$ALICE_PASS\"}" >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$BOB_USER\",\"email\":\"$BOB_EMAIL\",\"password\":\"$BOB_PASS\"}" >/dev/null

JWT=$(curl -fsS -X POST "$BASE_URL/api/v1/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$VIKUNJA_USER\",\"password\":\"$VIKUNJA_PASS\"}" | jq -r .token)
api() { curl -fsS -X "$1" "$BASE_URL/api/v1$2" -H "Authorization: Bearer $JWT" \
         -H 'Content-Type: application/json' ${3:+--data "$3"}; }

PROJECT=$(api PUT /projects "{\"title\":\"$PROJECT_NAME\"}" | jq .id)
BUG=$(api PUT /labels "{\"title\":\"$LABEL_BUG_NAME\",\"hex_color\":\"$LABEL_BUG_COLOR\"}" | jq .id)
DOCS=$(api PUT /labels "{\"title\":\"$LABEL_DOCS_NAME\",\"hex_color\":\"$LABEL_DOCS_COLOR\"}" | jq .id)

T1=$(api PUT "/projects/$PROJECT/tasks" "{\"title\":\"$WORK_ITEM_1_TITLE\",\"description\":\"$WORK_ITEM_1_DESC\",\"due_date\":\"$WORK_ITEM_1_DUE\"}" | jq .id)
api PUT "/tasks/$T1/labels" "{\"label_id\":$BUG}" >/dev/null
T2=$(api PUT "/projects/$PROJECT/tasks" "{\"title\":\"$WORK_ITEM_2_TITLE\",\"description\":\"$WORK_ITEM_2_DESC\"}" | jq .id)
api PUT "/tasks/$T2/labels" "{\"label_id\":$DOCS}" >/dev/null
T3=$(api PUT "/projects/$PROJECT/tasks" "{\"title\":\"$WORK_ITEM_3_TITLE\",\"description\":\"$WORK_ITEM_3_DESC\"}" | jq .id)
api POST "/tasks/$T3" '{"done":true}' >/dev/null
[ -z "${UNIQUE_TITLE:-}" ] || api PUT "/projects/$PROJECT/tasks" "{\"title\":\"$UNIQUE_TITLE\",\"description\":\"Deliberately exists only in this app.\"}" >/dev/null

log "seeded $BASE_URL"
