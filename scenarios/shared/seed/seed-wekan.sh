#!/usr/bin/env bash
# Seed a fresh Wekan instance with the shared fixtures.
#
# OPTIONAL: mapping detection runs on the spec files alone — seed data only
# matters once sync/adapter flows run against live apps. Create-only: run once
# after `docker compose up`; reset with `docker compose down -v`.
#
# Kanban has no done flag: WORK_ITEM_3 lands in a "Done" list (the archived
# flag is the deliberately wrong analog — see ground-truth.yaml).
#
# Required env: BASE_URL, WEKAN_USER, WEKAN_PASS + fixtures.env vars.
# Optional env: UNIQUE_TITLE — app-unique work item for honest non-overlap.
#
# Users (admin/alice/bob) are created by bootstrap-wekan.sh — the REST register
# endpoint is unusable in v9.x (see the note there).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
: "${BASE_URL:?}" "${WEKAN_USER:?}" "${WEKAN_PASS:?}"

LOGIN=$(curl -fsS -X POST "$BASE_URL/users/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$WEKAN_USER\",\"password\":\"$WEKAN_PASS\"}")
TOKEN=$(jq -re .token <<<"$LOGIN")
USER_ID=$(jq -re .id <<<"$LOGIN")
api() { curl -fsS -X "$1" "$BASE_URL$2" -H "Authorization: Bearer $TOKEN" \
         -H 'Content-Type: application/json' ${3:+--data "$3"}; }

BOARD=$(api POST /api/boards "{\"title\":\"$PROJECT_NAME\",\"owner\":\"$USER_ID\",\"permission\":\"private\",\"color\":\"belize\"}" | jq -r ._id)
SWIMLANE=$(api GET "/api/boards/$BOARD/swimlanes" | jq -r '(. // [])[0]._id // empty')
[ -n "$SWIMLANE" ] || SWIMLANE=$(api POST "/api/boards/$BOARD/swimlanes" '{"title":"Default"}' | jq -r ._id)
DOING=$(api POST "/api/boards/$BOARD/lists" '{"title":"Doing"}' | jq -r ._id)
DONE=$(api POST "/api/boards/$BOARD/lists" '{"title":"Done"}' | jq -r ._id)

card() { # list title description -> card id
  api POST "/api/boards/$BOARD/lists/$1/cards" \
    "{\"title\":\"$2\",\"description\":\"$3\",\"authorId\":\"$USER_ID\",\"swimlaneId\":\"$SWIMLANE\"}" | jq -r ._id
}
C1=$(card "$DOING" "$WORK_ITEM_1_TITLE" "$WORK_ITEM_1_DESC")
api PUT "/api/boards/$BOARD/lists/$DOING/cards/$C1" "{\"dueAt\":\"$WORK_ITEM_1_DUE\"}" >/dev/null
card "$DOING" "$WORK_ITEM_2_TITLE" "$WORK_ITEM_2_DESC" >/dev/null
card "$DONE" "$WORK_ITEM_3_TITLE" "$WORK_ITEM_3_DESC" >/dev/null
[ -z "${UNIQUE_TITLE:-}" ] || card "$DOING" "$UNIQUE_TITLE" "Deliberately exists only in this app." >/dev/null

log "seeded $BASE_URL"
