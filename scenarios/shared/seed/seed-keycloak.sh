#!/usr/bin/env bash
# Seed a fresh Keycloak instance (master realm) with the shared fixtures.
#
# OPTIONAL: mapping detection runs on the spec files alone — seed data only
# matters once sync/adapter flows run against live apps. Create-only: run once
# after `docker compose up`; reset with `docker compose down -v`.
#
# Required env: BASE_URL, KC_USER, KC_PASS (bootstrap admin from container env)
# + fixtures.env vars. Password-grant admin tokens are short-lived by design —
# a real mediator would use a service-account client (docs/architecture/security.md).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
: "${BASE_URL:?}" "${KC_USER:?}" "${KC_PASS:?}"
REALM=${REALM:-master}

TOKEN=$(curl -fsS -X POST "$BASE_URL/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli" \
  --data-urlencode "username=$KC_USER" --data-urlencode "password=$KC_PASS" | jq -re .access_token)
api() { curl -fsS -X "$1" "$BASE_URL/admin/realms/$REALM$2" -H "Authorization: Bearer $TOKEN" \
         -H 'Content-Type: application/json' ${3:+--data "$3"}; }

user() { # username email first last password -> user id (create returns no body)
  api POST /users "{\"username\":\"$1\",\"email\":\"$2\",\"firstName\":\"$3\",\"lastName\":\"$4\",\"enabled\":true,\"emailVerified\":true,\"credentials\":[{\"type\":\"password\",\"value\":\"$5\",\"temporary\":false}]}" >/dev/null
  api GET "/users?username=$1&exact=true" | jq -re '.[0].id'
}
ALICE_ID=$(user "$ALICE_USER" "$ALICE_EMAIL" "$ALICE_FIRST" "$ALICE_LAST" "$ALICE_PASS")
BOB_ID=$(user "$BOB_USER" "$BOB_EMAIL" "$BOB_FIRST" "$BOB_LAST" "$BOB_PASS")

api POST /groups "{\"name\":\"$PROJECT_NAME-team\"}" >/dev/null
GROUP_ID=$(api GET "/groups?search=$PROJECT_NAME-team" | jq -re '.[0].id')
api PUT "/users/$ALICE_ID/groups/$GROUP_ID" >/dev/null
api PUT "/users/$BOB_ID/groups/$GROUP_ID" >/dev/null

log "seeded $BASE_URL"
