#!/usr/bin/env bash
# Seed the scenario-3 landscape with fixture data (idempotent).
# Run after ./bootstrap.sh.
set -euo pipefail
cd "$(dirname "$0")"
set -a
source ../shared/fixtures.env
source .env
set +a

BASE_URL="http://localhost:${VIKUNJA_PORT}" \
  VIKUNJA_USER="$ADMIN_USER" VIKUNJA_PASS="$ADMIN_PASS" \
  UNIQUE_TITLE="$UNIQUE_VIKUNJA_TITLE" \
  ../shared/seed/seed-vikunja.sh
