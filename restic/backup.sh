#!/usr/bin/env bash
# Dumps every running Postgres container to $DUMP_DIR,
# then backs up $BACKUP_PATHS with restic (databases first, files after, as recommended by Immich).
# Also writes the Immich and repository sizes to $METRICS_DIR (node-exporter textfile collector, shown on the homepage)
# and the snapshot lists to $SNAPSHOTS_DIR (shown on the homepage).
# Options: --ha   also create a Home Assistant backup first (once a day)
#          --push also copy the snapshots to the Pi NAS ($RPI_REPOSITORY)
# Runs inside the restic container (see docker-compose.yml), scheduled by crond.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a

DUMP_DIR="${DUMP_DIR:-/data/backups/postgres}"
METRICS_DIR="${METRICS_DIR:-/data/grafana/textfile}"
SNAPSHOTS_DIR="${SNAPSHOTS_DIR:-/data/backups/snapshots}"
IMMICH_DB_CONTAINER="${IMMICH_DB_CONTAINER:-immich_postgres}"
ha=0 push=0
for arg in "$@"; do
  case "$arg" in
    --ha) ha=1 ;;
    --push) push=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Backups run every 2 hours: keep them all for 24 hours (counted from the latest snapshot),
# then one per day/week/month. Grouped by host+tags (not paths) so changing BACKUP_PATHS doesn't
# leave the old snapshots in a separate group that is never pruned.
keep=(--group-by host,tags --keep-within-hourly 24h --keep-daily 7 --keep-weekly 4 --keep-monthly 12)

exec 9>/tmp/homelab-backup.lock
flock -n 9 || { echo "Another backup is already running"; exit 1; }

log() { echo "[$(date '+%F %T')] $*"; }

# Atomically writes stdin to $METRICS_DIR/$1.prom; failures only warn (metrics are not backups)
metrics() {
  local f="$METRICS_DIR/$1.prom"
  if ! { cat > "$f.tmp" && chmod 644 "$f.tmp" && mv "$f.tmp" "$f"; }; then
    log "WARNING: could not write $f"
    rm -f "$f.tmp"
  fi
}

# $1: repo label, then the restic command for that repository
repo_metrics() {
  local label=$1 size
  shift
  if size=$("$@" stats --mode raw-data --json | grep -o '"total_size":[0-9]*' | cut -d: -f2) && [[ -n "$size" ]]; then
    printf 'homelab_restic_repo_size_bytes{repo="%s"} %s\n' "$label" "$size" | metrics "restic-$label"
  else
    log "WARNING: could not get the size of the $label repository"
  fi
}

# Snapshot list as JSON (only reads the snapshot files, cheap); $1: repo label, then the restic command for that repository
snapshots_json() {
  local label=$1 f="$SNAPSHOTS_DIR/$1.json"
  shift
  if ! { "$@" snapshots --tag homelab --json > "$f.tmp" && chmod 644 "$f.tmp" && mv "$f.tmp" "$f"; }; then
    log "WARNING: could not write $f"
    rm -f "$f.tmp"
  fi
}

mkdir -p "$DUMP_DIR" "$SNAPSHOTS_DIR"
# Readable by the homepage (runs as nobody)
chmod 755 "$SNAPSHOTS_DIR"
failed=0

# Uses the automatic backup settings (agents, encryption, retention) from Settings > System > Backups.
# The API call returns once the backup is written to /config/backups.
if [[ "$ha" == 1 && -n "${HA_TOKEN:-}" ]]; then
  log "Creating Home Assistant backup"
  if ! curl -fsS --max-time 1800 -X POST -H @- -H 'Content-Type: application/json' \
      "${HA_URL:-http://127.0.0.1:8123}/api/services/backup/create_automatic" \
      <<< "Authorization: Bearer $HA_TOKEN" > /dev/null; then
    log "ERROR: Home Assistant backup failed"
    failed=1
  fi
fi

# Uncompressed dumps with a fixed name per container: restic dedupes and compresses them far better than .gz files.
for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /postgres|postgis/ {print $1}'); do
  log "Dumping $c"
  if docker exec "$c" sh -c 'pg_dumpall --clean --if-exists -U "$POSTGRES_USER"' > "$DUMP_DIR/$c.sql.tmp"; then
    mv "$DUMP_DIR/$c.sql.tmp" "$DUMP_DIR/$c.sql"
  else
    log "ERROR: dump of $c failed, keeping previous dump"
    rm -f "$DUMP_DIR/$c.sql.tmp"
    failed=1
  fi
done

# Size of the Immich originals from its database (scanning the NAS share takes far too long); thumbnails and encoded videos not included
if immich=$(docker exec "$IMMICH_DB_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-immich}" -Atc "SELECT COALESCE(sum(\"fileSizeInByte\"), 0) FROM asset_exif"' 2>&1) \
    && [[ "$immich" =~ ^[0-9]+$ ]]; then
  printf 'homelab_immich_originals_bytes %s\n' "$immich" | metrics immich
else
  log "WARNING: could not get the Immich size: $immich"
fi

read -ra paths <<< "$BACKUP_PATHS"

log "restic backup ${paths[*]}"
# --ignore-inode: the CIFS shares don't keep stable inode numbers, which made every file look changed
# --group-by host,tags: pick the parent snapshot regardless of paths, else changing BACKUP_PATHS re-reads every file
# --no-scan: the size estimate (progress %) is a second full walk of every path, costly on the CIFS shares
restic backup --tag homelab --ignore-inode --no-scan --group-by host,tags --exclude-file "$SCRIPT_DIR/excludes.txt" "${paths[@]}"

log "restic forget/prune"
# Not fatal: the metrics and snapshot list below must still be updated
if ! restic forget --tag homelab "${keep[@]}" --prune; then
  log "ERROR: forget/prune failed"
  failed=1
fi
repo_metrics nas restic
snapshots_json nas restic

# Second copy on the WD My Cloud behind the Pi, over SFTP via Tailscale (same password, same retention).
# The SSH key is passphrase-protected: load it into a temporary ssh-agent.
if [[ "$push" == 1 && -n "${RPI_REPOSITORY:-}" ]]; then
  log "restic copy to $RPI_REPOSITORY"
  eval "$(ssh-agent -s)" > /dev/null
  trap 'ssh-agent -k > /dev/null' EXIT
  askpass=$(mktemp)
  printf '#!/bin/sh\ncat /run/secrets/rpi_ssh_passphrase\n' > "$askpass"
  chmod 700 "$askpass"
  rpi=(restic -r "$RPI_REPOSITORY" -o sftp.args="-o BatchMode=yes -o UserKnownHostsFile=/run/secrets/rpi_known_hosts -o ServerAliveInterval=60")
  if ! { SSH_ASKPASS="$askpass" SSH_ASKPASS_REQUIRE=force timeout 30 ssh-add -q /run/secrets/rpi_ssh_key < /dev/null \
      && "${rpi[@]}" copy --tag homelab --from-repo "$RESTIC_REPOSITORY" --from-password-file "$RESTIC_PASSWORD_FILE" \
      && "${rpi[@]}" forget --tag homelab "${keep[@]}" --prune; }; then
    log "ERROR: copy to Pi NAS failed"
    failed=1
  else
    repo_metrics rpi "${rpi[@]}"
    snapshots_json rpi "${rpi[@]}"
  fi
  rm -f "$askpass"
fi

log "Done"
exit "$failed"
