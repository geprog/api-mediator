# Spec sources for scenario 2 — consumed by shared/fetch-specs.sh.
# Format: "app|url|outfile" (fetched into specs/full/).
# Wekan and Keycloak don't serve their specs — vendored from the published,
# version-matched URLs (tags in .env are pinned to keep image and spec in step).
SPEC_SOURCES=(
  "gitea|http://localhost:${GITEA_PORT}/swagger.v1.json|gitea-${GITEA_TAG}.swagger.json"
  "vikunja|http://localhost:${VIKUNJA_PORT}/api/v1/docs.json|vikunja-${VIKUNJA_TAG}.swagger.json"
  "wekan|https://wekan.fi/api/${WEKAN_TAG}/wekan.yml|wekan-${WEKAN_TAG}.swagger.yml"
  "keycloak|https://www.keycloak.org/docs-api/${KEYCLOAK_TAG}/rest-api/openapi.json|keycloak-${KEYCLOAK_TAG}.openapi.json"
)
