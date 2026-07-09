# Spec sources for scenario 3 — consumed by shared/fetch-specs.sh.
# Format: "app|url|outfile" (fetched into specs/full/).
# The consumer spec (specs/consumer/todo-widget.yaml) is hand-written, not fetched.
SPEC_SOURCES=(
  "vikunja|http://localhost:${VIKUNJA_PORT}/api/v1/docs.json|vikunja-${VIKUNJA_TAG}.swagger.json"
)
