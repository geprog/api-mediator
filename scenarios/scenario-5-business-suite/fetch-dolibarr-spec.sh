#!/usr/bin/env bash
# Fetch Dolibarr's spec. usage: fetch-dolibarr-spec.sh <output.json>
#
# Unauthenticated, /api/index.php/explorer/swagger.json returns a 2-operation
# stub (login/status); the full module-aware spec needs the DOLAPIKEY header,
# so this reads the key that bootstrap.sh saved to .tokens.env.
set -euo pipefail
cd "$(dirname "$0")"
source ../shared/lib.sh
set -a; source .env; source .tokens.env; set +a

OUT=${1:?usage: fetch-dolibarr-spec.sh <output.json>}
: "${DOLIBARR_API_KEY:?run ./bootstrap.sh first}"

# Restler emits optional path params and duplicate operationIds — repair with
# the shared normalizer while vendoring.
curl -fsS -H "DOLAPIKEY: $DOLIBARR_API_KEY" \
  "http://localhost:${DOLIBARR_PORT}/api/index.php/explorer/swagger.json" \
  | python3 ../shared/normalize-spec.py >"$OUT"
