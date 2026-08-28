#!/usr/bin/env bash
set -Eeuo pipefail

log_dir="/app/runs/logs"
mkdir -p "$log_dir"

log_file="$log_dir/$(date -u +%Y%m%d-%H%M%S)-$$.log"
printf 'Console log: %s\n' "$log_file"

node /app/run_auto_update.mjs "$@" 2>&1 | tee "$log_file"
