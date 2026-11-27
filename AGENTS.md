# AGENTS.md

Docker Compose stacks for a single homelab server (`thome-server`) plus a Raspberry Pi (`rpi/`). Overview of the services, auth modes and URLs: [README.md](README.md). This repo is public on GitHub.

## Never commit

- Secrets, tokens, passwords, IPs (LAN or Tailscale) or internal hostnames. Use placeholders such as `<RPI_TAILSCALE_IP>`.
- `.env`, `config.json`, `*/secrets/*` are ignored; each has a committed `.dist` template with placeholder values. Adding a variable or secret means updating the `.dist` too.
- Never print the content of a secret file in the terminal or chat; refer to it by path.
- `todo.md` is a local-only personal checklist, ignored by Git. Never force-add or commit it.

## Conventions

- One folder per stack with its `docker-compose.yml`; extra config files next to it. Persistent data lives in `/data/<stack>`, not in the repo.
- Web apps: on the external `traefik-net` network, `traefik.enable=true`, router on the `websecure` entrypoint, `Host(...)` on `thomega.fr` subdomains, `traefik.docker.network=traefik-net`. TLS and the wildcard Let's Encrypt certificate are set on the `websecure` entrypoint, so routers don't need `tls.certresolver`.
- Auth: prefer the app's own OAuth2/OIDC login with Authentik (`.env` client settings, `.env.dist` placeholders) whenever the app supports it. Otherwise put it behind the `authentik-auth@docker` forward-auth middleware, which needs an Authentik proxy provider (forward auth, single application) for the host, attached to the embedded outpost, and disable the app's own login when it can without losing features (single login through Authentik; The Lounge keeps its accounts, since its public mode drops the IRC connection and history when the tab closes). Public only on purpose.
- Authentik objects can be created with `docker exec authentik_server ak shell -c '...'` (Django ORM); copy flows and property mappings from an existing provider of the same type. Every application gets `meta_icon` set to its dashboard-icons URL (`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/<name>.svg`, as in the homepage `config.yml`). Proxy providers: `external_host` with a trailing slash, then `set_oauth_defaults()` and `save()`, otherwise the redirect URIs are missing or mismatched ("Redirect URI Error"). OAuth2 providers: set the exact callback URL from the app's docs as a strict redirect URI. Check the login redirect with curl afterwards. Access rights follow the application group (homepage group of the same name): `App Admin` bound to the `admin` group, `App Admin/Tech Bro` to `admin` + `Techos Friends`.
- Pin image versions (no `latest`). Update checks by What's Up Docker: use `wud.tag.include`/`wud.tag.exclude`/`wud.watch.digest` labels to match the image's tag scheme, `wud.watch=false` for locally built images.
- New or removed stack: update the README (service list, mermaid graph, authentication table, URLs) and the homepage `config.yml` service list.
- Comments explain why, in English. Commit messages: one imperative sentence describing the change.
- When the user teaches a new convention or a fix during a chat, add it to this file without being asked.

## Environment

- Sessions can run in the `vscode` container (code-server, as root) or directly on the host through SSH. Confirm the current session context before assuming container limitations or restart impact. In the container, the host Docker socket and CLI are available; `/data` and `/home/thome` are mounted at the same paths. No `python3`, `jq` or `node` there: use `docker exec <container> ...` or a throwaway container.
- Host shell: `docker run --rm --privileged --pid=host alpine nsenter -t 1 -m -u -i -n -p -- sh -c '...'`; read-only inspection: `docker run --rm -v /:/host:ro alpine ...`.
- NAS CIFS shares `/mnt/nas` and `/mnt/nas-images` are host fstab mounts. NetworkManager can report online too early at boot, so a docker.service drop-in (`/etc/systemd/system/docker.service.d/wait-nas.conf` → `/usr/local/sbin/wait-nas-mounts.sh`) retries them for 60 s before Docker starts (details: README "Host: NAS mounts before Docker"). If they are missing anyway (restic exits 127 "open /mnt/nas/backups", Immich restarts on `.immich` folder checks): `systemctl start mnt-nas.mount 'mnt-nas\x2dimages.mount'` on the host, then restart restic, Immich and Nextcloud.
- `/home/thome/makabe` and `/home/thome/LabOrchestra` are separate Compose projects outside this repo (`fanfare-makabes.fr`, their own Watchtower), served by the same Traefik. Both are backed up by restic (`makabe` also through the `makabe-db` dump). Leave them alone.

## Before acting

Ask first before: restarting or recreating a stack other than the one being edited, `docker compose down`, deleting volumes or `/data` content, `restic unlock`/`forget`/`prune` by hand, changes on the host outside Docker, anything on the Pi, `git push`.

Restarting `traefik` or `authentik` interrupts shared web access. Restarting `vscode` disconnects code-server editor/agent sessions, but not an independent host SSH session; do not automatically exclude its update when operating through SSH.

The ISP box is the LAN DHCP and DNS server (the server uses it too). Pi-hole is not used by default: it was dropped after repeated outages, probably caused by its macvlan network.

## Image upgrades

- Read the release notes between the current and target versions for breaking changes or removed services before bumping a tag.
- Back up first to `/data/backups/pre-upgrade-YYYYMMDD`; stop SQLite-based apps before copying their data (WAL files). restic already dumps Postgres containers to `/data/backups/postgres`.
- WUD API needs basic auth: query it from inside with `docker exec wud node -e` and `fetch('http://localhost:3000/api/containers')`, credentials from the container's `WUD_AUTH_ADMIN_USER`/`WUD_AUTH_ADMIN_PASSWORD` env. Force a re-check with `POST /api/containers/<id>/watch`.

## Authentik (`authentik/`)

- Treat updates/recreation as a shared-access outage risk: if Authentik cannot start, Traefik loses the `authentik-auth@docker` middleware defined on its server container and protected apps can return 404 despite healthy app containers.
- Recreation can expose a mismatch between the configured database password and PostgreSQL's stored role password. `POSTGRES_PASSWORD` only initializes a new database; changing it or recreating Postgres does not update an existing role. An image update alone is not evidence that it changed the password.
- Before and after an upgrade, test password authentication over the database container's network interface, not localhost or a Unix socket (both use `trust` here and can falsely suggest the password works):

  ```sh
  docker exec authentik_postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$(hostname -i)" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT 1" >/dev/null'
  ```

- If Authentik logs `password authentication failed for user "authentik"`, verify that the server/worker's `AUTHENTIK_POSTGRESQL__PASSWORD` matches the database container's `POSTGRES_PASSWORD` without displaying either value, and confirm they target the intended database. If they match but the TCP test fails, ask permission before synchronizing the stored role password. Do not delete/reinitialize the database or weaken authentication.
- Back up the roles privately first; the dump contains password verifiers and must not be printed or committed. This path persists under `/data/authentik/postgres/backups` on the host:

  ```sh
  docker exec authentik_postgres sh -c 'umask 077; mkdir -p /var/lib/postgresql/backups; pg_dumpall -U "$POSTGRES_USER" --globals-only > "/var/lib/postgresql/backups/roles-before-password-repair-$(date -u +%Y%m%dT%H%M%SZ).sql"'
  ```

- After authorization and a successful backup, synchronize the existing `authentik` role with the configured password using `psql`'s client-side password encryption, without putting the secret in SQL text, command arguments or terminal output:

  ```sh
  docker exec authentik_postgres sh -c 'printf "%s\n%s\n" "$POSTGRES_PASSWORD" "$POSTGRES_PASSWORD" | psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\password authentik"'
  ```

- Repeat the TCP test, wait for both `authentik_server` and `authentik_worker` to become healthy, and check login redirects with `curl` for `https://auth.thomega.fr/`, `https://wud.thomega.fr/` and Homepage at `https://thomega.fr/` (not `homepage.thomega.fr`). Following redirects should reach HTTP 200 login pages. The crash-looping containers can recover automatically; do not restart Traefik or unrelated stacks.

## restic (`restic/`)

- Runs in the `restic` container; `crond` calls `backup.sh` every 2 h, with `--ha` daily at 02:00 and `--push` (copy to the Pi's WD My Cloud over SFTP) Monday and Thursday at 02:00. Logs: `docker logs restic`.
- `backup.sh` is bind-mounted and bash reads it while running. Check `docker exec restic pgrep -fl 'backup.sh|restic'` before editing it. While a run is in progress, write the new version to a temporary file and `mv` it over `backup.sh` (new inode), never edit in place, and delete the temporary file.
- BookStack MariaDB is dumped by `dump-mariadb.sh` into `$DUMP_DIR/$BOOKSTACK_DB_CONTAINER.sql` before restic runs. Keep the InnoDB check, single-transaction dump and atomic replacement; a failed or empty dump must abort the backup. Live BookStack database files and private restore-test directories are excluded; restore into a fresh database using the backed-up application credentials and configuration.
- `container-restarts.sh` runs every minute via restic's cron and atomically publishes Docker `RestartCount` plus a collection timestamp to node-exporter. Keep it independent of the backup lock; stale collection must fail monitoring. Do not use cAdvisor `container_start_time_seconds` to detect restarts: it stayed unchanged during controlled restarts.
- A run takes ~2 h; overlapping runs exit with "Another backup is already running", which also skips a scheduled push.
- Keep `--ignore-inode`: the CIFS shares have unstable inode numbers, without it every file looks changed and runs take 4-7 h. Keep `--group-by host,tags` on `restic backup` too: by default the parent snapshot is matched by paths, so changing `BACKUP_PATHS` would re-read the whole ~1 TB.
- New path in `BACKUP_PATHS`: also mount it in `docker-compose.yml` and recreate the container at the same time, between two runs. A path missing in the container makes `restic backup` fail and the script stop.
- Manual push: `docker exec -d restic sh -c '/home/thome/homelab-compose/restic/backup.sh --push > /proc/1/fd/1 2>&1'` (backup, prune, then copy).
- "repository is already locked" with an old lock date means a stale lock (container restarted mid-run): `docker exec restic restic unlock` removes only stale locks.
- `backup.sh` writes `/data/backups/snapshots/{nas,rpi}.json` and `/data/grafana/textfile/*.prom`, read by the homepage Backups and Storage cards.

## homepage (`homepage/`)

- `static/` and `app.py` are baked into the image: rebuild with `docker compose up -d --build homepage`. `config.yml` is mounted: `docker restart homepage` is enough.

## Uptime Kuma (`uptime-kuma/`)

- Five `[Reliability]` monitors are managed by `reliability.js` through the native Socket.IO API, without restarting Kuma. Preserve unrelated monitors and notification bindings; take a private online SQLite backup before edits. Backup-age limits come from the homepage; missing/stale sources must fail checks. Ask before using `--test-notification` to send a Discord test (details: `uptime-kuma/README.md`).
- The shared Discord notification uses the native custom template with 🚨 outage, ✅ recovery and 🧪 test emojis. Reapply with `reliability.js --discord-emojis`; this updates only notification formatting, preserves bindings and sends no test by default. Do not patch the vendor notification provider.

## BookStack (`book-stack/`)

- Recovery testing: use a private restored working copy on an internal-only Docker network, without production mounts, published ports or Traefik; use local authentication in the test instance and never reset production credentials. SQL-based recovery was verified before excluding live MariaDB files; distinguish local-login testing from OIDC testing (details: `book-stack/README.md`).
- Keep OSCP maintenance scripts, browser tests and their guide in `/data/many-notes/bookstack/tools/oscp/`, outside this Git repository. The installed pages and variable helper are stored in BookStack, not loaded from those source files.
- The OSCP site requires Authentik login. For authorized local maintenance, the app is in `/app/www` inside `oscp-bookstack`, with persistent config at `/config`. Bootstrap PHP with `vendor/autoload.php`, `bootstrap/app.php`, then the console kernel; inspect the current models and methods before using them.
- Use native `PageRepo::update` under the appropriate existing user, not direct SQL updates, to retain revisions, search indexing and reference updates. Use it for renames too, since titles can change page slugs and links.
- Before changing pages, save a private backup outside the repo (e.g. `/config/backups`, files mode `0600`), check for edit drafts and concurrent changes, and preview the result. Wrap related updates and their validation in a database transaction.
- BookStack regenerates HTML IDs unless they start with `bkmrk`. Give imported elements unique `bkmrk-...` IDs; otherwise inserted examples can take existing bookmark IDs and break links. Verify existing bookmarks and their text after native HTML formatting.
- When integrating notes into a course, distribute code and explanations into the matching sections without overwriting existing content. Preserve the source page unchanged unless explicitly asked otherwise; verify every source code block was copied and unrelated pages remain unchanged.
- Use topic-specific titles for command collections (e.g. “Web Applications and Client-Side Attacks Commands”), since there may be several such pages. Do not silently correct source snippets or execute them while reorganizing documentation.
- In command generators, show the exact variable name in each form label alongside its French description, and use the same name in validation messages (e.g. `SMB_SHARE (Partage SMB)`).
- Keep Step-by-Step Commands free of legacy-page reference lists and compatibility-navigation sections; retain the commands and current course links only.
- OSCP report values are saved with the page (not temporary browser forms), with command-output blocks and captioned screenshot slots. Exam uses native Markdown and BookStack's automatically generated heading bookmarks, without explicit or trailing legacy HTML anchors. Link to the existing enumeration section with `step-by-step-commands#bkmrk-oscp-enumeration`. Training Labs retains its visual-editor format. Keep the Exam structure: three standalone machines with initial-access and privilege-escalation parts, followed by Active Directory.
- Keep Exam compact: credentials are username/password/usage lists, with NT hashes only for AD; Nmap/ffuf are screenshots only. Merge each access/escalation path with its proof. No key/source metadata, generic extra-service sections, or cleanup. Do not apply these Exam-only changes to Training Labs without a request.
- Keep Exam's UTC introduction, sensitive-data notice, `STARTED_UTC`/`FINISHED_UTC`, and per-machine `OPEN_PORTS`/`TARGET_URL`/`MACHINE_STATUS`. AD hosts use host/role, IP/network access, services/URL and status/proof columns; keep a short users/groups/notes section separate from credentials.
- Write the entire Exam report in English, including headings, field descriptions, table columns, notices and screenshot captions. Keep variable names unchanged and use native generated bookmarks; do not translate other course pages or the French command generator as part of this rule.

## Raspberry Pi (`rpi/`)

- Setup and services: [rpi/README.md](rpi/README.md). SSH as `thome` (passwordless sudo) with `restic/secrets/rpi-ssh-key`: passphrase-protected, load it into a temporary `ssh-agent` with `SSH_ASKPASS` reading `restic/secrets/rpi-ssh-passphrase`, `UserKnownHostsFile=restic/secrets/rpi-known-hosts`; host from `RPI_REPOSITORY` in `restic/.env`. Kill the agent afterwards.
- The Pi has its own checkout of this repo with local uncommitted edits: change files there with targeted edits, never overwrite them. It uses `sudo docker compose`.
- The WD My Cloud is a CIFS share mounted on the Pi at `/mnt/wdmycloud` (`/etc/fstab` there). The current mount uses guest access and SMB 2.1; the stored `restic/secrets/wdmycloud-password` is not used by this mount or restic. `x-systemd.automount` plus `/etc/cron.d/wdmycloud-mount` triggers access after a 60-second boot delay and every 5 minutes. A controlled reboot verified recovery and off-site repository access on 2026-11-27; the historical failure was not reproduced. If it recurs, capture mount/automount and kernel CIFS journals before changing configuration. Confirm a real CIFS mount before any write test to avoid writing to the Pi's SD card.
