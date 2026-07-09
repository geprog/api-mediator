# Spec sources for scenario 5 — consumed by shared/fetch-specs.sh.
# Format: "app|url|outfile" (fetched into specs/full/). script: sources run a
# local script instead of curl — Kimai's spec sits behind a session login and
# OrangeHRM's must be generated from the container's annotated sources.
SPEC_SOURCES=(
  "dolibarr|script:./fetch-dolibarr-spec.sh|dolibarr-${DOLIBARR_TAG}.swagger.json"
  "kimai|script:./fetch-kimai-spec.sh|kimai-${KIMAI_TAG#apache-}.openapi.json"
  "orangehrm|script:./fetch-orangehrm-spec.sh|orangehrm-${ORANGEHRM_TAG}.openapi.json"
)
