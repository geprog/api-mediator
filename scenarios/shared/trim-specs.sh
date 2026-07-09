#!/usr/bin/env bash
# Produce a trimmed subset of a vendored spec for cheap LLM mapping-detection runs.
#
# usage: trim-specs.sh <app> <in.json> <out.json>
#
# Keeps only paths matching the app's keep-list (exact match or subtree), then
# prunes now-unreferenced components via prune-swagger-refs.py.
#
# INVARIANT: trimmed specs must stay sync-operable (docs/architecture/sync-engine.md):
# every kept resource keeps its list op, create/update/delete ops, single-id path
# op, pagination params, and updated-timestamp-bearing schemas, so ResourceBinding
# refs (nativeIdRef, collectionReadRef, paginationRef, changeTimestampRef) all
# resolve inside the subset. Extend keep-lists rather than shrinking them.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

APP=${1:?usage: trim-specs.sh <app> <in.json> <out.json>}
IN=${2:?}
OUT=${3:?}

# Keep-list entries match a path subtree; a trailing "$" means exact match only.
case "$APP" in
  gitea | forgejo)
    PREFIXES=(
      "/repos/{owner}/{repo}/issues"
      "/repos/{owner}/{repo}/labels"
      "/repos/{owner}/{repo}/milestones"
      "/repos/issues/search$"
      "/admin/users"
      "/users$"
      "/users/{username}$"
      "/user$"
    )
    ;;
  vikunja)
    PREFIXES=(
      "/projects$"
      "/projects/{id}$"
      "/projects/{id}/tasks$"
      "/tasks$"
      "/tasks/{id}$"
      "/tasks/{task}/labels"
      "/tasks/{taskID}/comments"
      "/labels"
      "/users$"
      "/user$"
      "/login$"
      "/register$"
      "/tokens"
    )
    ;;
  wekan)
    PREFIXES=(
      "/users"
      "/api/users"
      "/api/boards"
    )
    ;;
  keycloak)
    PREFIXES=(
      "/admin/realms/{realm}/users"
      "/admin/realms/{realm}/groups"
    )
    ;;
  dolibarr)
    PREFIXES=(
      "/users"
      "/thirdparties"
      "/projects"
      "/tasks"
    )
    ;;
  kimai)
    PREFIXES=(
      "/api/users"
      "/api/customers"
      "/api/projects"
      "/api/activities"
      "/api/timesheets"
    )
    ;;
  orangehrm)
    PREFIXES=(
      "/api/v2/pim/employees"
      "/api/v2/admin/users"
      "/api/v2/attendance"
      "/api/v2/time"
    )
    ;;
  *)
    die "no keep-list defined for app '$APP'"
    ;;
esac

TMP=$(mktemp)
jq '.paths |= with_entries(
      .key as $k
      | select($ARGS.positional | map(
          if endswith("$") then $k == .[:-1]
          else . as $p | ($k == $p) or ($k | startswith($p + "/"))
          end
        ) | any)
    )' "$IN" --args "${PREFIXES[@]}" >"$TMP"

python3 "$(dirname "${BASH_SOURCE[0]}")/prune-swagger-refs.py" "$TMP" "$OUT"
rm -f "$TMP"
log "wrote $OUT"
