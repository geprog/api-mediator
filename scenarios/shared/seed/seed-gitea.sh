#!/usr/bin/env bash
# Seed a fresh Gitea/Forgejo instance with the shared fixtures.
#
# OPTIONAL: mapping detection runs on the spec files alone — seed data only
# matters once sync/adapter flows run against live apps. Create-only: run once
# after `docker compose up`; reset with `docker compose down -v`.
#
# Required env: BASE_URL, TOKEN + fixtures.env vars (caller exports).
# Optional env: UNIQUE_TITLE — app-unique work item for honest non-overlap.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
: "${BASE_URL:?}" "${TOKEN:?}"

api() { curl -fsS -X "$1" "$BASE_URL/api/v1$2" -H "Authorization: token $TOKEN" \
         -H 'Content-Type: application/json' ${3:+--data "$3"}; }

api POST /admin/users "{\"username\":\"$ALICE_USER\",\"email\":\"$ALICE_EMAIL\",\"password\":\"$ALICE_PASS\",\"full_name\":\"$ALICE_FIRST $ALICE_LAST\",\"must_change_password\":false}" >/dev/null
api POST /admin/users "{\"username\":\"$BOB_USER\",\"email\":\"$BOB_EMAIL\",\"password\":\"$BOB_PASS\",\"full_name\":\"$BOB_FIRST $BOB_LAST\",\"must_change_password\":false}" >/dev/null
api POST "/admin/users/$ALICE_USER/repos" "{\"name\":\"$PROJECT_NAME\",\"auto_init\":true}" >/dev/null

REPO="/repos/$ALICE_USER/$PROJECT_NAME"
BUG=$(api POST "$REPO/labels" "{\"name\":\"$LABEL_BUG_NAME\",\"color\":\"#$LABEL_BUG_COLOR\"}" | jq .id)
DOCS=$(api POST "$REPO/labels" "{\"name\":\"$LABEL_DOCS_NAME\",\"color\":\"#$LABEL_DOCS_COLOR\"}" | jq .id)

api POST "$REPO/issues" "{\"title\":\"$WORK_ITEM_1_TITLE\",\"body\":\"$WORK_ITEM_1_DESC\",\"labels\":[$BUG],\"due_date\":\"$WORK_ITEM_1_DUE\"}" >/dev/null
api POST "$REPO/issues" "{\"title\":\"$WORK_ITEM_2_TITLE\",\"body\":\"$WORK_ITEM_2_DESC\",\"labels\":[$DOCS]}" >/dev/null
N=$(api POST "$REPO/issues" "{\"title\":\"$WORK_ITEM_3_TITLE\",\"body\":\"$WORK_ITEM_3_DESC\"}" | jq .number)
api PATCH "$REPO/issues/$N" '{"state":"closed"}' >/dev/null
[ -z "${UNIQUE_TITLE:-}" ] || api POST "$REPO/issues" "{\"title\":\"$UNIQUE_TITLE\",\"body\":\"Deliberately exists only in this app.\"}" >/dev/null

log "seeded $BASE_URL"
