#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a
METRICS_DIR="${METRICS_DIR:-/data/grafana/textfile}"
mkdir -p "$METRICS_DIR"
tmp=$(mktemp "$METRICS_DIR/container-restarts.XXXXXX")
trap 'rm -f "$tmp"' EXIT

if ! ids=$(timeout 30 docker ps -aq --no-trunc) || [[ -z "$ids" ]]; then
  echo "ERROR: could not list containers for restart metrics" >&2
  exit 1
fi
readarray -t containers <<< "$ids"
if ! data=$(timeout 30 docker inspect --format '{{.Name}} {{.Id}} {{.RestartCount}}' "${containers[@]}"); then
  echo "ERROR: could not inspect containers for restart metrics" >&2
  exit 1
fi

printf '# TYPE homelab_container_restart_count_total counter\n' > "$tmp"
while read -r name id count extra; do
  if [[ ! "$name" =~ ^/[a-zA-Z0-9][a-zA-Z0-9_.-]*$ || ! "$id" =~ ^[a-f0-9]{64}$ || ! "$count" =~ ^[0-9]+$ || -n "$extra" ]]; then
    echo "ERROR: invalid container restart metrics" >&2
    exit 1
  fi
  printf 'homelab_container_restart_count_total{container="%s",id="%s"} %s\n' "${name#/}" "$id" "$count" >> "$tmp"
done <<< "$data"
printf 'homelab_container_restarts_collected_timestamp_seconds %s\n' "$(date +%s)" >> "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$METRICS_DIR/container-restarts.prom"
