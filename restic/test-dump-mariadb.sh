#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

cat > "$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == ps ]]; then
  exit 0
fi
[[ "$1" == exec && "$2" == test-db ]]
shift 2
exec "$@"
EOF
cat > "$work/bin/mariadb" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ -n "$MYSQL_PWD" ]]
if [[ "${QUERY_FAIL:-0}" == 1 ]]; then exit 1; fi
printf '%s\n' "${NON_INNODB:-0}"
EOF
cat > "$work/bin/mariadb-dump" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ -n "$MYSQL_PWD" ]]
for flag in --single-transaction --quick --routines --events --triggers --hex-blob --databases; do
  [[ " $* " == *" $flag "* ]]
done
case "${DUMP_MODE:-success}" in
  success) printf '%s\n' 'CREATE DATABASE bookstack;' ;;
  partial) printf '%s\n' 'partial SQL'; exit 1 ;;
  empty) exit 0 ;;
esac
EOF
cat > "$work/bin/restic" <<'EOF'
#!/usr/bin/env bash
touch "$RESTIC_CALLED"
EOF
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"
export MARIADB_ROOT_PASSWORD=test-only MARIADB_DATABASE=bookstack
target="$work/dumps/test-db.sql"

bash "$script_dir/dump-mariadb.sh" test-db "$target"
grep -qx 'CREATE DATABASE bookstack;' "$target"
[[ "$(stat -c %a "$target")" == 600 && ! -e "$target.tmp" ]]
echo 'PASS: successful dump has required flags and private permissions'

for failure in partial empty non-innodb query; do
  export DUMP_MODE=success NON_INNODB=0 QUERY_FAIL=0
  case "$failure" in
    partial|empty) export DUMP_MODE="$failure" ;;
    non-innodb) export NON_INNODB=1 ;;
    query) export QUERY_FAIL=1 ;;
  esac
  if bash "$script_dir/dump-mariadb.sh" test-db "$target" > "$work/error.log" 2>&1; then
    echo "FAIL: $failure unexpectedly succeeded" >&2
    exit 1
  fi
  grep -qx 'CREATE DATABASE bookstack;' "$target"
  [[ ! -e "$target.tmp" ]]
  grep -q ERROR "$work/error.log"
  echo "PASS: $failure failure retains previous dump and removes partial output"
done

cp "$script_dir/backup.sh" "$script_dir/dump-mariadb.sh" "$work/"
cat > "$work/.env" <<EOF
BOOKSTACK_DB_CONTAINER=test-db
DUMP_DIR=$work/dumps
SNAPSHOTS_DIR=$work/snapshots
METRICS_DIR=$work/metrics
BACKUP_PATHS=$work/dumps
EOF
export QUERY_FAIL=0 NON_INNODB=0 DUMP_MODE=partial
export RESTIC_CALLED="$work/restic-called"
if bash "$work/backup.sh" > "$work/backup.log" 2>&1; then
  echo 'FAIL: backup unexpectedly succeeded after dump failure' >&2
  exit 1
fi
[[ ! -e "$RESTIC_CALLED" ]]
grep -q 'MariaDB dump failed; backup aborted' "$work/backup.log"
grep -qx 'CREATE DATABASE bookstack;' "$target"
echo 'PASS: backup aborts before restic when MariaDB dump fails'
