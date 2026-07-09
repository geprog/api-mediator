#!/usr/bin/env bash
# Seed the scenario-2 landscape with overlapping fixture data.
# OPTIONAL — only needed for sync/adapter testing; detection uses specs/ alone.
# Create-only: run once after ./bootstrap.sh; reset with `docker compose down -v`.
set -euo pipefail
cd "$(dirname "$0")"
set -a
source ../shared/fixtures.env
source .env
source .tokens.env
set +a

BASE_URL="http://localhost:${GITEA_PORT}" TOKEN="$GITEA_TOKEN" \
  UNIQUE_TITLE="$UNIQUE_GITEA_TITLE" \
  ../shared/seed/seed-gitea.sh

BASE_URL="http://localhost:${VIKUNJA_PORT}" \
  VIKUNJA_USER="$ADMIN_USER" VIKUNJA_PASS="$ADMIN_PASS" \
  UNIQUE_TITLE="$UNIQUE_VIKUNJA_TITLE" \
  ../shared/seed/seed-vikunja.sh

BASE_URL="http://localhost:${WEKAN_PORT}" \
  WEKAN_USER="$ADMIN_USER" WEKAN_PASS="$ADMIN_PASS" \
  UNIQUE_TITLE="$UNIQUE_WEKAN_TITLE" \
  ../shared/seed/seed-wekan.sh

BASE_URL="http://localhost:${KEYCLOAK_PORT}" \
  KC_USER="$KC_ADMIN_USER" KC_PASS="$KC_ADMIN_PASS" \
  ../shared/seed/seed-keycloak.sh
