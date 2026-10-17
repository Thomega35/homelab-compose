#!/usr/bin/env bash
# Dumps every running Postgres container to $DUMP_DIR,
# then backs up $BACKUP_PATHS with restic (databases first, files after, as recommended by Immich).
# Options: --ha   also create a Home Assistant backup first (once a day)
#          --push also copy the snapshots to the Pi NAS ($RPI_REPOSITORY)
# Runs inside the restic container (see docker-compose.yml), scheduled by crond.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a

DUMP_DIR="${DUMP_DIR:-/data/backups/postgres}"
ha=0 push=0
for arg in "$@"; do
  case "$arg" in
    --ha) ha=1 ;;
    --push) push=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Backups run every 2 hours: keep them for 24 hours, then one per day/week/month.
keep=(--keep-hourly 24 --keep-daily 7 --keep-weekly 4 --keep-monthly 12)

exec 9>/tmp/homelab-backup.lock
flock -n 9 || { echo "Another backup is already running"; exit 1; }

log() { echo "[$(date '+%F %T')] $*"; }

mkdir -p "$DUMP_DIR"
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

read -ra paths <<< "$BACKUP_PATHS"

log "restic backup ${paths[*]}"
restic backup --tag homelab --exclude-file "$SCRIPT_DIR/excludes.txt" "${paths[@]}"

log "restic forget/prune"
restic forget --tag homelab "${keep[@]}" --prune

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
  fi
  rm -f "$askpass"
fi

log "Done"
exit "$failed"
