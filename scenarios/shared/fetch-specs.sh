#!/usr/bin/env bash
# Fetch/vendor the OpenAPI specs of a scenario into <scenario>/specs/full/.
#
# usage: fetch-specs.sh <scenario-dir> [--check]
#
# Sources <scenario>/spec-sources.sh, which must define SPEC_SOURCES as an array
# of "app|url|outfile" entries (URLs may use ports/tags from the scenario .env).
# Live-served specs require the landscape to be running.
#
# A source of the form "script:./some-script.sh" runs that script (relative to
# the scenario dir) with the output path as $1 instead of curl-ing a URL — for
# apps whose spec needs generation or an authenticated session.
#
# JSON specs are piped through `jq -S` for stable diffs. With --check, specs are
# re-fetched and diffed against the vendored copies (volatile fields like
# info.version normalized away) so an image bump can't silently drift the spec.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SCENARIO_DIR=${1:?usage: fetch-specs.sh <scenario-dir> [--check]}
MODE=${2:-fetch}
cd "$SCENARIO_DIR"

set -a
source .env
set +a
source spec-sources.sh # defines SPEC_SOURCES

mkdir -p specs/full
FAILED=0

normalize() { # strip fields that change without the API surface changing
  jq -S 'del(.info.version) | del(.host) | del(.servers)'
}

for entry in "${SPEC_SOURCES[@]}"; do
  IFS='|' read -r app url outfile <<<"$entry"
  target="specs/full/$outfile"
  tmp=$(mktemp)
  log "fetching $app spec: $url"
  if [[ $url == script:* ]]; then
    "${url#script:}" "$tmp" || die "spec script failed: ${url#script:}"
  else
    curl -fsSL --retry 3 "$url" -o "$tmp" || die "failed to fetch $url"
  fi

  if [[ $outfile == *.json ]]; then
    jq -S . "$tmp" >"$tmp.sorted" && mv "$tmp.sorted" "$tmp"
  fi

  if [ "$MODE" = "--check" ]; then
    if [ ! -f "$target" ]; then
      warn "$target missing — run without --check first"
      FAILED=1
    elif [[ $outfile == *.json ]]; then
      if ! diff -q <(normalize <"$tmp") <(normalize <"$target") >/dev/null; then
        warn "$app spec drifted from vendored $target"
        FAILED=1
      else
        log "$app spec matches vendored copy"
      fi
    else
      if ! diff -q "$tmp" "$target" >/dev/null; then
        warn "$app spec drifted from vendored $target"
        FAILED=1
      else
        log "$app spec matches vendored copy"
      fi
    fi
  else
    mv "$tmp" "$target"
    log "wrote $target"
  fi
  rm -f "$tmp"
done

[ "$FAILED" = 0 ] || die "spec check failed — vendored specs no longer match their sources"
