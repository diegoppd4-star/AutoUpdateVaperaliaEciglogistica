#!/usr/bin/env bash
set -Eeuo pipefail

source_dir="${CODEX_HOST_HOME:-$HOME/.codex}"
bootstrap_names=(
  auth.json
)
bootstrap_files=()

for name in "${bootstrap_names[@]}"; do
  if [[ -f "$source_dir/$name" ]]; then
    bootstrap_files+=("$name")
  fi
done

if [[ ! -f "$source_dir/auth.json" ]]; then
  printf 'Missing required Codex authentication file: %s/auth.json\n' "$source_dir" >&2
  exit 1
fi

printf 'Importing Codex bootstrap files from %s\n' "$source_dir"
tar -C "$source_dir" -cf - "${bootstrap_files[@]}" \
  | sudo docker compose --profile tools run --rm -T codex-bootstrap

printf 'Codex bootstrap volume is ready.\n'
