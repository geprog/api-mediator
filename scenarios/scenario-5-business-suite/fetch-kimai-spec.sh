#!/usr/bin/env bash
# Extract Kimai's OpenAPI spec. usage: fetch-kimai-spec.sh <output.json>
#
# Kimai's production build registers no /api/doc.json route and the
# nelmio:apidoc:dump console command crashes without a user context — the only
# spec source is the session-gated /api/doc Stoplight page, which inlines the
# document as `apiDescriptionDocument = {"spec": {...}}`.
set -euo pipefail
cd "$(dirname "$0")"
source ../shared/lib.sh
set -a; source ../shared/fixtures.env; source .env; set +a

OUT=${1:?usage: fetch-kimai-spec.sh <output.json>}
BASE="http://localhost:${KIMAI_PORT}"
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

CSRF=$(curl -fsS -c "$JAR" "$BASE/en/login" \
  | grep -oE 'name="_csrf_token" value="[^"]+"' | cut -d'"' -f4)
curl -fsS -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE/en/login_check" \
  --data-urlencode "_username=admin" --data-urlencode "_password=$ADMIN_PASS" \
  --data-urlencode "_csrf_token=$CSRF"

curl -fsS -b "$JAR" "$BASE/api/doc" | python3 -c '
import json, sys
html = sys.stdin.read()
marker = "apiDescriptionDocument = "
i = html.find(marker)
if i < 0:
    sys.exit("apiDescriptionDocument not found — not logged in?")
obj, _ = json.JSONDecoder().raw_decode(html[i + len(marker):])
json.dump(obj["spec"], sys.stdout)' >"$OUT"
