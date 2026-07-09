#!/usr/bin/env bash
# Ensure a Vikunja admin user exists and mint a long-lived tk_ API token.
# Prints the token on stdout, or nothing (with a warning) if minting failed —
# seed scripts log in themselves, so a missing token is not fatal.
#
# Required env: BASE_URL, ADMIN_USER, ADMIN_PASS, ADMIN_EMAIL.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

: "${BASE_URL:?}" "${ADMIN_USER:?}" "${ADMIN_PASS:?}" "${ADMIN_EMAIL:?}"

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/v1/register" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$ADMIN_USER" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" \
        '{username: $u, email: $e, password: $p}')")
case $code in
  200|201) log "created vikunja user $ADMIN_USER" ;;
  400|409|412) log "vikunja user $ADMIN_USER exists (HTTP $code)" ;;
  *) die "vikunja register failed: HTTP $code" ;;
esac

JWT=$(curl -fsS -X POST "$BASE_URL/api/v1/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$ADMIN_USER" --arg p "$ADMIN_PASS" '{username: $u, password: $p}')" \
  | jq -r .token)

# Vikunja 2.x login JWTs expire after ~10 minutes; a tk_ API token is what a
# long-running mediator would use. GET /routes advertises token-able routes as
# {group: {permission: {path, method}}}; PUT /tokens wants {group: [permission]}.
if PERMISSIONS=$(curl -fsS "$BASE_URL/api/v1/routes" -H "Authorization: Bearer $JWT" \
     | jq 'with_entries(.value |= keys)') \
   && TOKEN=$(curl -fsS -X PUT "$BASE_URL/api/v1/tokens" \
        -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
        -d "$(jq -n --argjson p "$PERMISSIONS" \
              '{title: ("mediator-" + (now | tostring)), expires_at: "2030-01-01T00:00:00Z", permissions: $p}')" \
        | jq -re .token); then
  printf '%s' "$TOKEN"
else
  warn "could not mint a Vikunja API token — a mediator will need one created via the UI"
fi
