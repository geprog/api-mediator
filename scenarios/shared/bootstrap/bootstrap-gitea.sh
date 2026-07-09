#!/usr/bin/env bash
# Ensure a Gitea/Forgejo admin user exists and mint an access token.
# Prints the token on stdout.
#
# Required env: SERVICE (compose service name), BINARY (gitea|forgejo),
# ADMIN_USER, ADMIN_PASS, ADMIN_EMAIL. Must run in the scenario directory.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

: "${SERVICE:?}" "${BINARY:?}" "${ADMIN_USER:?}" "${ADMIN_PASS:?}" "${ADMIN_EMAIL:?}"

# The CLI must run as the container's git user, not root.
if docker compose exec -T -u git "$SERVICE" "$BINARY" admin user list \
    | awk '{print $2}' | grep -qx "$ADMIN_USER"; then
  log "$SERVICE admin $ADMIN_USER exists"
else
  log "creating $SERVICE admin $ADMIN_USER"
  docker compose exec -T -u git "$SERVICE" "$BINARY" admin user create \
    --admin --username "$ADMIN_USER" --password "$ADMIN_PASS" \
    --email "$ADMIN_EMAIL" --must-change-password=false >&2
fi

# Tokens are write-only; a fresh uniquely-named one per run is cheapest.
# Scopeless tokens can't do anything (go-gitea#33474) — always pass --scopes.
docker compose exec -T -u git "$SERVICE" "$BINARY" admin user generate-access-token \
  --username "$ADMIN_USER" --token-name "mediator-$(date +%s%N)" --scopes all --raw \
  | tr -d '[:space:]'
