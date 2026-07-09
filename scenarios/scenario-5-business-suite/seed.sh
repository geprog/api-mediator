#!/usr/bin/env bash
# Seed the scenario-5 landscape with overlapping business fixtures.
# OPTIONAL — only needed for sync/adapter testing; detection uses specs/ alone.
# Create-only: run once after ./bootstrap.sh; reset with `docker compose down -v`.
set -euo pipefail
cd "$(dirname "$0")"
set -a
source ../shared/fixtures.env
source .env
source .tokens.env
set +a

BASE_URL="http://localhost:${DOLIBARR_PORT}" TOKEN="$DOLIBARR_API_KEY" \
  ../shared/seed/seed-dolibarr.sh

BASE_URL="http://localhost:${KIMAI_PORT}" TOKEN="$KIMAI_TOKEN" \
  ../shared/seed/seed-kimai.sh

BASE_URL="http://localhost:${ORANGEHRM_PORT}" \
  OHRM_USER="$ADMIN_USER" OHRM_PASS="$ADMIN_PASS_STRICT" \
  ../shared/seed/seed-orangehrm.sh
