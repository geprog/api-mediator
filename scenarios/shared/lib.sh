#!/usr/bin/env bash
# Shared helpers for scenario bootstrap/seed scripts. Source this file.
# Requires: bash, curl, jq.

set -euo pipefail

log()  { printf '\033[1;34m>>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool '$1' not found"; }
need curl
need jq

# wait_for_http <url> [timeout=180] — poll until the URL answers with 2xx/3xx.
# Used for apps whose image cannot carry a container-side healthcheck.
wait_for_http() {
  local url=$1 timeout=${2:-180} start
  start=$(date +%s)
  log "waiting for $url"
  while ! curl -fsS -o /dev/null --max-time 5 "$url" 2>/dev/null; do
    if (( $(date +%s) - start >= timeout )); then
      die "timed out after ${timeout}s waiting for $url"
    fi
    sleep 2
  done
}

# save_token <file> <KEY> <value> — upsert KEY=value in a token env file.
save_token() {
  local file=$1 key=$2 value=$3
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
  log "saved ${key} to ${file}"
}
