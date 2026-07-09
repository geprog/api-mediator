#!/usr/bin/env bash
# Create admin users + API tokens for the scenario-2 landscape (idempotent).
# Writes tokens to .tokens.env (gitignored). Run after: docker compose up -d --wait
set -euo pipefail
cd "$(dirname "$0")"
source ../shared/lib.sh
set -a
source ../shared/fixtures.env
source .env
set +a

TOKENS_FILE=.tokens.env

wait_for_http "http://localhost:${GITEA_PORT}/api/healthz"
wait_for_http "http://localhost:${VIKUNJA_PORT}/api/v1/info"
wait_for_http "http://localhost:${WEKAN_PORT}/" 300 # no container healthcheck
wait_for_http "http://localhost:${KEYCLOAK_PORT}/realms/master"

GITEA_TOKEN=$(SERVICE=gitea BINARY=gitea ../shared/bootstrap/bootstrap-gitea.sh)
save_token "$TOKENS_FILE" GITEA_TOKEN "$GITEA_TOKEN"

VIKUNJA_TOKEN=$(BASE_URL="http://localhost:${VIKUNJA_PORT}" ../shared/bootstrap/bootstrap-vikunja.sh)
[ -n "$VIKUNJA_TOKEN" ] && save_token "$TOKENS_FILE" VIKUNJA_TOKEN "$VIKUNJA_TOKEN"

read -r WEKAN_TOKEN WEKAN_USER_ID < <(WEKAN_URL="http://localhost:${WEKAN_PORT}" ../shared/bootstrap/bootstrap-wekan.sh)
save_token "$TOKENS_FILE" WEKAN_TOKEN "$WEKAN_TOKEN"
save_token "$TOKENS_FILE" WEKAN_USER_ID "$WEKAN_USER_ID"

# Keycloak needs no token bootstrap: the bootstrap admin comes from the
# container env, and password-grant admin tokens are short-lived by design.

log "bootstrap done — tokens in $TOKENS_FILE"
