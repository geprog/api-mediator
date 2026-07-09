#!/usr/bin/env bash
# One-shot spec pipeline for a scenario: fetch → trim → convert → validate.
# Requires the scenario's landscape to be running (for live-served specs).
#
# usage: build-specs.sh <scenario-dir>
set -euo pipefail
SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SHARED_DIR/lib.sh"

SCENARIO_DIR=${1:?usage: build-specs.sh <scenario-dir>}
SCENARIO_DIR="$(cd "$SCENARIO_DIR" && pwd)"

"$SHARED_DIR/fetch-specs.sh" "$SCENARIO_DIR"

cd "$SCENARIO_DIR"
set -a; source .env; set +a
source spec-sources.sh
mkdir -p specs/trimmed specs/oas3

VALIDATE=()
for entry in "${SPEC_SOURCES[@]}"; do
  IFS='|' read -r app url outfile <<<"$entry"
  full="specs/full/$outfile"

  if [[ $outfile == *.yml || $outfile == *.yaml ]]; then
    # Trimming operates on JSON; convert YAML specs first (YAML parses bare
    # response codes (200:) as int keys — json.dump stringifies them), then
    # repair known upstream spec sins via the shared normalizer.
    json="specs/full/${outfile%.*}.json"
    python3 -c 'import json,sys,yaml; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)' "$full" \
      | python3 "$SHARED_DIR/normalize-spec.py" | jq -S . >"$json"
    full="$json"
  fi

  trimmed="specs/trimmed/${app}.trimmed.swagger.json"
  "$SHARED_DIR/trim-specs.sh" "$app" "$full" "$trimmed"

  "$SHARED_DIR/convert-specs.sh" "$full" "specs/oas3/${app}.full.oas3.json"
  "$SHARED_DIR/convert-specs.sh" "$trimmed" "specs/oas3/${app}.trimmed.oas3.json"

  VALIDATE+=("$full" "$trimmed" "specs/oas3/${app}.full.oas3.json" "specs/oas3/${app}.trimmed.oas3.json")
done

# Hand-written consumer specs are validated too, when present.
while IFS= read -r -d '' consumer; do
  VALIDATE+=("$consumer")
done < <(find specs/consumer -name '*.yaml' -print0 2>/dev/null || true)

"$SHARED_DIR/validate-specs.sh" "${VALIDATE[@]}"
log "spec pipeline done for $SCENARIO_DIR"
