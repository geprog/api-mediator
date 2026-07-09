#!/usr/bin/env bash
# Validate vendored specs in two tiers:
#   hard  — file parses and every $ref resolves (the one requirement the
#           mediator's ingestion has, docs/architecture/mapping-engine.md)
#   soft  — full schema validation; real-world generated specs (Gitea, Vikunja)
#           violate the strict OpenAPI schema in places, so this only warns.
#
# usage: validate-specs.sh <spec-file>...
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ $# -gt 0 ] || die "usage: validate-specs.sh <spec-file>..."

FAILED=0
for f in "$@"; do
  if ! npx --yes @apidevtools/swagger-cli@4 validate --no-schema "$f" >/dev/null 2>&1; then
    warn "FAIL $f (unparseable or unresolvable \$refs)"
    npx --yes @apidevtools/swagger-cli@4 validate --no-schema "$f" 2>&1 | head -5 >&2 || true
    FAILED=1
  elif ! npx --yes @apidevtools/swagger-cli@4 validate "$f" >/dev/null 2>&1; then
    log "OK   $f (with upstream strict-schema violations — expected for generated specs)"
  else
    log "OK   $f"
  fi
done
[ "$FAILED" = 0 ] || die "spec validation failed"
