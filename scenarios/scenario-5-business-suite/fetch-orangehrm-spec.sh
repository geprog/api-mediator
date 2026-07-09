#!/usr/bin/env bash
# Generate OrangeHRM's OpenAPI spec. usage: fetch-orangehrm-spec.sh <output.json>
#
# OrangeHRM publishes no built spec (it is a devTools build artifact, and the
# production image prunes swagger-php from vendor/). This reproduces the
# devTools generator inside the running container: swagger-php (the version
# pinned in the app's own composer.lock) is fetched once with a throwaway
# composer container, copied in, and run against the annotated plugin sources
# WITH the app's autoloader — required so that annotation constant references
# (FooSearchFilterParams::ALLOWED_SORT_FIELDS, …API::MODEL_DEFAULT) resolve;
# without it those docblocks are dropped and ~60 operations silently go missing.
set -euo pipefail
cd "$(dirname "$0")"
source ../shared/lib.sh

OUT=${1:?usage: fetch-orangehrm-spec.sh <output.json>}

if ! docker compose exec -T orangehrm test -f /tmp/swagger-gen/vendor/autoload.php 2>/dev/null; then
  log "installing swagger-php 4.8.4 into the orangehrm container"
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  docker run --rm -v "$WORK":/out docker.io/library/composer:2.7 sh -c \
    'cd /out && composer require --quiet zircote/swagger-php:4.8.4 doctrine/annotations:^1.14 >/dev/null 2>&1'
  docker compose cp "$WORK" orangehrm:/tmp/swagger-gen >/dev/null
fi

# stderr silenced: swagger-php warns about OrangeHRM's nameless per-plugin
# config classes; failures are caught by the size check below instead.
docker compose exec -T orangehrm php -r '
error_reporting(E_ALL ^ E_DEPRECATED ^ E_NOTICE ^ E_WARNING);
require "/var/www/html/src/vendor/autoload.php";
require "/tmp/swagger-gen/vendor/autoload.php";
$openapi = \OpenApi\Generator::scan(\OpenApi\Util::finder(["/var/www/html/src/plugins"]));
file_put_contents("/tmp/openapi.json", $openapi->toJson());
' 2>/dev/null || true

docker compose exec -T orangehrm cat /tmp/openapi.json >"$OUT"
[ "$(stat -c%s "$OUT")" -gt 100000 ] || die "OrangeHRM spec generation produced no usable output"
