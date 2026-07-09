#!/usr/bin/env bash
# Create the admin user + API token for the scenario-3 landscape (idempotent).
# Writes tokens to .tokens.env (gitignored). Run after: docker compose up -d --wait
set -euo pipefail
cd "$(dirname "$0")"
source ../shared/lib.sh
set -a
source ../shared/fixtures.env
source .env
set +a

TOKENS_FILE=.tokens.env

wait_for_http "http://localhost:${VIKUNJA_PORT}/api/v1/info"

VIKUNJA_TOKEN=$(BASE_URL="http://localhost:${VIKUNJA_PORT}" ../shared/bootstrap/bootstrap-vikunja.sh)
[ -n "$VIKUNJA_TOKEN" ] && save_token "$TOKENS_FILE" VIKUNJA_TOKEN "$VIKUNJA_TOKEN"

log "bootstrap done — tokens in $TOKENS_FILE"
