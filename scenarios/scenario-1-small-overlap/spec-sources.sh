# Spec sources for scenario 1 — consumed by shared/fetch-specs.sh.
# Format: "app|url|outfile" (fetched into specs/full/).
SPEC_SOURCES=(
  "gitea|http://localhost:${GITEA_PORT}/swagger.v1.json|gitea-${GITEA_TAG}.swagger.json"
  "vikunja|http://localhost:${VIKUNJA_PORT}/api/v1/docs.json|vikunja-${VIKUNJA_TAG}.swagger.json"
)
