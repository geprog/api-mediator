#!/usr/bin/env bash
# Create admin users + API tokens for the scenario-1 landscape (idempotent).
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

GITEA_TOKEN=$(SERVICE=gitea BINARY=gitea ../shared/bootstrap/bootstrap-gitea.sh)
save_token "$TOKENS_FILE" GITEA_TOKEN "$GITEA_TOKEN"

VIKUNJA_TOKEN=$(BASE_URL="http://localhost:${VIKUNJA_PORT}" ../shared/bootstrap/bootstrap-vikunja.sh)
[ -n "$VIKUNJA_TOKEN" ] && save_token "$TOKENS_FILE" VIKUNJA_TOKEN "$VIKUNJA_TOKEN"

log "bootstrap done — tokens in $TOKENS_FILE"
