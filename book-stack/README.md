# BookStack recovery

## Restore test: 2026-11-27

Restic snapshot `d6df1de9` (2026-11-27 12:00 CET) was restored into
`/data/backups/restore-tests/bookstack-20261127-1350`, not into production.
The directory is mode `0700`; credential files and verification results are
mode `0600`. It contains sensitive application data and must not be committed
or shared.

Results:

- Restic restored 273.148 MiB and verified all 1,012 files.
- MariaDB `11.4` recovered the copied database; all 41 application tables passed
  `mariadb-check`.
- BookStack `version-v26.09.3` successfully authenticated a restored admin user
  with a temporary password set only in the test database.
- All 31 published pages rendered over HTTP. The database contained one book,
  205 page revisions and four users.
- All 80 stored images were retrieved over HTTP and matched their file hashes.
- There were no local attachments, so attachment downloads were not exercised.
- Authentik OIDC was not tested: the isolated instance used local authentication
  and had no external network access.
- Production remained healthy. Both test containers and their internal Docker
  network were removed; private restore files and results were retained.

The private directory contains `restored/` (the verified backup), `runtime/`
(the working copy), `verification.json`, `database-check.txt`, and
`verify-bookstack-restore.php`. The verifier changes an admin password and must
only run against the isolated test database.

## Consistent SQL backups

The raw-directory snapshot above had no SQL dump. Successful recovery of a copied
live database does **not** guarantee that future copies are consistent.

The restic job now runs [dump-mariadb.sh](../restic/dump-mariadb.sh) before each
backup, using `BOOKSTACK_DB_CONTAINER` (default `oscp-bookstack-db`). It writes
`$DUMP_DIR/<container>.sql`; the default path is
`/data/backups/postgres/oscp-bookstack-db.sql`. The directory name is retained for
compatibility with existing PostgreSQL backups.

- Dumps use `--single-transaction --quick`, include routines, events and triggers,
  and preserve binary data with `--hex-blob`.
- The application database must contain only InnoDB tables; the helper checks
  this and fails explicitly otherwise. Do not run schema migrations or other DDL
  concurrently with a dump.
- Credentials are read inside the database container, not printed or passed as
  password arguments. Dumps are mode `0600`.
- A completed, nonempty dump atomically replaces the previous file. Query,
  dump or empty-output failures retain the previous dump and abort the backup
  before restic can create a snapshot containing a stale MariaDB dump.
- The SQL dump contains the application database, not MariaDB system accounts.
  Recreate the application database user from the backed-up private environment
  settings when restoring into a fresh MariaDB instance.
- Live BookStack database files and private recovery-test directories are now
  excluded. Configuration, the original `APP_KEY`, uploaded files and images
  remain backed up alongside the dump; a database-only backup is insufficient.

### SQL restore test: 2026-11-27

A fresh 18,514,883-byte dump was imported into a new MariaDB `11.4` data directory,
without copying any live database files. BookStack `version-v26.09.3` then passed
local HTTP login, all 31 published pages, all 80 image hash checks and all 41
database table checks. No attachments were present; OIDC was not tested.

Private evidence is retained under
`/data/backups/restore-tests/bookstack-sql-20261127-1403`. The test containers and
network were removed without changing production.

A restic dry run verified the SQL dump is selected while live database contents
and recovery-test contents are excluded. The changed job is picked up by the
next scheduled run; the active older run was not restarted. This test restored
the freshly generated SQL file, not a SQL file from a completed restic snapshot.

Focused failure and integration tests:

```sh
docker run --rm --network none --entrypoint bash \
  --mount type=bind,src="$PWD/restic",dst=/work,readonly \
  homelab-restic:0.19.1 /work/test-dump-mariadb.sh
```

Run from the repository root. The tests mock Docker and restic and never access
production databases.

## Repeating an isolated restore test

1. Choose an explicit restic snapshot containing
   `/data/many-notes/bookstack/config` and the SQL dump. Check available
   disk space and create a new private directory under `/data/backups/restore-tests`.
2. Restore with `restic restore <SNAPSHOT_ID> --target <PRIVATE_TEST_DIR>/restored
   --include /data/many-notes/bookstack/config
   --include /data/backups/postgres/<DB_CONTAINER>.sql --verify` inside the restic
   container. For historical snapshots predating SQL dumps, raw-directory
   recovery is best-effort only.
3. Copy restored files into a separate working directory. Never mount production
   directories into test containers.
4. Use the backed-up application and database image versions on a new
   `docker network create --internal <TEST_NETWORK>` network. Publish no ports,
   do not join `traefik-net`, and set `traefik.enable=false` and `wud.watch=false`.
5. Initialize a fresh MariaDB data directory with the backed-up application
   database user and credentials. Import the restored SQL with `mariadb -uroot
   --binary-mode`, providing the root password through `MYSQL_PWD` inside the
   container and piping the private SQL file to stdin; never print it.
6. Prepare private environment files without printing secrets. Preserve the
   original `APP_KEY` and application database credentials;
   override `DB_HOST` and `APP_URL` to the test containers. Use
   `AUTH_METHOD=standard`, `MAIL_DRIVER=log` and `SESSION_SECURE_COOKIE=false`
   for an internal HTTP-only test. Do not use production OIDC client settings.
7. Check database readiness and every application table with `mariadb-check`.
   Verify actual HTTP login, published pages, images and any attachments, not
   merely that the login screen loads. Record any untested features explicitly.
8. Stop and remove only the test containers and network. Retain private evidence
   and confirm production health. Ask before deleting retained restore data.
