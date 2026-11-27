#!/usr/bin/env bash
set -euo pipefail
umask 077

container=${1:?Pass the MariaDB container name}
target=${2:?Pass the SQL dump path}
mkdir -p "$(dirname "$target")"
tmp="$target.tmp"
trap 'rm -f "$tmp"' EXIT
: > "$tmp"
chmod 600 "$tmp"

if ! docker exec "$container" sh -ec '
    : "${MARIADB_ROOT_PASSWORD:?Missing MariaDB root password}"
    : "${MARIADB_DATABASE:?Missing MariaDB application database}"
    export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"
    non_innodb=$(mariadb -uroot --batch --skip-column-names \
        --database "$MARIADB_DATABASE" \
        -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='\''BASE TABLE'\'' AND (ENGINE IS NULL OR ENGINE <> '\''InnoDB'\'')")
    if [ "$non_innodb" != 0 ]; then
        echo "ERROR: single-transaction dump requires all application tables to use InnoDB" >&2
        exit 1
    fi
    exec mariadb-dump -uroot --single-transaction --quick --routines \
        --events --triggers --hex-blob --databases "$MARIADB_DATABASE"
' > "$tmp"; then
    echo "ERROR: MariaDB dump of $container failed; previous dump retained" >&2
    exit 1
fi

if [[ ! -s "$tmp" ]]; then
    echo "ERROR: MariaDB dump of $container is empty; previous dump retained" >&2
    exit 1
fi
mv "$tmp" "$target"
