#!/usr/bin/env bash
# Convert a Swagger 2.0 spec to OpenAPI 3.0.x JSON. Files that are already
# OAS3 are copied through unchanged (e.g. Keycloak).
#
# usage: convert-specs.sh <in.json|in.yml> <out.json>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IN=${1:?usage: convert-specs.sh <in> <out.json>}
OUT=${2:?}

if [[ $IN == *.json ]] && jq -e '.openapi // empty' "$IN" >/dev/null; then
  log "$IN is already OAS3 — copying"
  jq -S . "$IN" >"$OUT"
  exit 0
fi

# --patch fixes the minor spec sins that generated Swagger files tend to have.
npx --yes swagger2openapi@7 --patch "$IN" -o "$OUT" >/dev/null
# swagger2openapi emits JSON for .json outfiles; normalize key order for diffs.
jq -S . "$OUT" >"$OUT.tmp" && mv "$OUT.tmp" "$OUT"
log "wrote $OUT"
