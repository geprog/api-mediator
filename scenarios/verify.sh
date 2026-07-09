#!/usr/bin/env bash
# Full verification cycle for one scenario — also the CI recipe.
# usage: verify.sh <scenario-dir>
#
# DESTRUCTIVE: starts from `docker compose down -v` (seed scripts are
# create-only and expect a fresh landscape).
set -euo pipefail
cd "$(dirname "$0")"
source shared/lib.sh

SCENARIO=${1:?usage: verify.sh <scenario-dir>}
SCENARIO=${SCENARIO%/}
cd "$SCENARIO"

log "[1/8] compose config lints"
docker compose config -q

log "[2/8] fresh landscape up (healthchecks green)"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --wait

log "[3/8] bootstrap — and a second run must be a no-op"
./bootstrap.sh
./bootstrap.sh

log "[4/8] seed (create-only, once)"
[ -x ./seed.sh ] && ./seed.sh

log "[5/8] spec pipeline (fetch -> trim -> convert -> validate)"
../shared/build-specs.sh .

log "[6/8] vendored specs still match their live sources"
../shared/fetch-specs.sh . --check

log "[7/8] ground truth references only operations that exist in the specs"
python3 ../shared/check-ground-truth.py .

log "[8/8] teardown"
docker compose down -v

log "verify OK: $SCENARIO"
