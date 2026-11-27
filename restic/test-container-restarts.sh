#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin" "$work/metrics"
cp "$script_dir/container-restarts.sh" "$work/"
printf 'METRICS_DIR=%s/metrics\n' "$work" > "$work/.env"
cat > "$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ps) printf '%064d\n' 1 ;;
  inspect)
    if [[ "${INSPECT_FAIL:-0}" == 1 ]]; then exit 1; fi
    printf '/test-app %064d %s\n' 1 "${COUNT:-3}"
    ;;
esac
EOF
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"
bash "$work/container-restarts.sh"
target="$work/metrics/container-restarts.prom"
grep -q '^homelab_container_restart_count_total{container="test-app",id=".*"} 3$' "$target"
grep -q '^homelab_container_restarts_collected_timestamp_seconds [0-9]*$' "$target"
[[ "$(stat -c %a "$target")" == 644 ]]
cp "$target" "$work/expected"
echo 'PASS: Docker restart counters and collection time are published'
for failure in inspect invalid-count; do
  export INSPECT_FAIL=0 COUNT=3
  if [[ "$failure" == inspect ]]; then export INSPECT_FAIL=1; else export COUNT=invalid; fi
  if bash "$work/container-restarts.sh" > "$work/error.log" 2>&1; then
    echo "FAIL: $failure unexpectedly succeeded" >&2
    exit 1
  fi
  cmp "$target" "$work/expected"
  grep -q ERROR "$work/error.log"
  [[ "$(find "$work/metrics" -type f | wc -l)" == 1 ]]
  echo "PASS: $failure retains the last sample and removes partial output"
done
