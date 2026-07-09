#!/usr/bin/env bash
#
# dev-up.sh — start the local development infrastructure for the API Mediator.
#
# Brings up the containers defined in the repo-root docker-compose.yml:
#   - PostgreSQL          (the mediator's data store)
#   - Grafana LGTM stack  (OTLP receiver + Prometheus/Tempo/Loki + Grafana)
#
# The mediator app itself and Ollama run on the host during development
# (see DEVELOPMENT.md); this script only provisions the container infra.
#
# Usage:  ./scripts/dev-up.sh
#
set -euo pipefail

# Resolve the repository root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Starting local dev infrastructure (Postgres + Grafana LGTM)…"
echo "    compose file: ${REPO_ROOT}/docker-compose.yml"

# --wait blocks until every service with a healthcheck reports healthy.
docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d --wait

# Resolve the Grafana host port the same way docker compose does — from .env,
# falling back to the compose default — so the printed URL is a real value.
GRAFANA_PORT="$(grep -E '^GRAFANA_PORT=' "${REPO_ROOT}/.env" 2>/dev/null | tail -n1 | cut -d '=' -f2- | tr -d '[:space:]' || true)"
GRAFANA_PORT="${GRAFANA_PORT:-3000}"

echo "==> Infrastructure is up."
echo "    Postgres:  see DATABASE_URL in .env"
echo "    Grafana:   http://localhost:${GRAFANA_PORT}"
