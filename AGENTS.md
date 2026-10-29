# AGENTS.md

Docker Compose stacks for a single homelab server (`thome-server`) plus a Raspberry Pi (`rpi/`). Overview of the services, auth modes and URLs: [README.md](README.md). This repo is public on GitHub.

## Never commit

- Secrets, tokens, passwords, IPs (LAN or Tailscale) or internal hostnames. Use placeholders such as `<RPI_TAILSCALE_IP>`.
- `.env`, `config.json`, `*/secrets/*` are ignored; each has a committed `.dist` template with placeholder values. Adding a variable or secret means updating the `.dist` too.
- Never print the content of a secret file in the terminal or chat; refer to it by path.

## Conventions

- One folder per stack with its `docker-compose.yml`; extra config files next to it. Persistent data lives in `/data/<stack>`, not in the repo.
- Web apps: on the external `traefik-net` network, `traefik.enable=true`, router on the `websecure` entrypoint, `Host(...)` on `thomega.fr` subdomains, `traefik.docker.network=traefik-net`. TLS and the wildcard Let's Encrypt certificate are set on the `websecure` entrypoint, so routers don't need `tls.certresolver`.
- Auth: either the `authentik-auth@docker` forward-auth middleware, or the app's own OIDC login with Authentik. Public only on purpose.
- Pin image versions (no `latest`). Update checks by What's Up Docker: use `wud.tag.include`/`wud.tag.exclude`/`wud.watch.digest` labels to match the image's tag scheme, `wud.watch=false` for locally built images.
- New or removed stack: update the README (service list, mermaid graph, authentication table, URLs) and the homepage `config.yml` service list.
- Comments explain why, in English. Commit messages: one imperative sentence describing the change.

## Environment

- The agent runs in the `vscode` container (code-server, as root) with the host Docker socket and CLI; `/data` and `/home/thome` are mounted at the same paths. No `python3`, `jq` or `node`: use `docker exec <container> ...` or a throwaway container.
- Host shell: `docker run --rm --privileged --pid=host alpine nsenter -t 1 -m -u -i -n -p -- sh -c '...'`; read-only inspection: `docker run --rm -v /:/host:ro alpine ...`.
- `/home/thome/makabe` and `/home/thome/LabOrchestra` are separate Compose projects outside this repo (`fanfare-makabes.fr`, their own Watchtower), served by the same Traefik and backed up by restic. Leave them alone.

## Before acting

Ask first before: restarting or recreating a stack other than the one being edited, `docker compose down`, deleting volumes or `/data` content, `restic unlock`/`forget`/`prune` by hand, changes on the host outside Docker, anything on the Pi, `git push`.

Restarting `traefik` or `authentik` cuts access to every web app, and `vscode` kills this editor session.

The ISP box is the LAN DHCP and DNS server (the server uses it too). Pi-hole is not used by default: it was dropped after repeated outages, probably caused by its macvlan network.

## Image upgrades

- Read the release notes between the current and target versions for breaking changes or removed services before bumping a tag.
- Back up first to `/data/backups/pre-upgrade-YYYYMMDD`; stop SQLite-based apps before copying their data (WAL files). restic already dumps Postgres containers to `/data/backups/postgres`.
- WUD API needs basic auth: query it from inside with `docker exec wud node -e` and `fetch('http://localhost:3000/api/containers')`, credentials from the container's `WUD_AUTH_ADMIN_USER`/`WUD_AUTH_ADMIN_PASSWORD` env. Force a re-check with `POST /api/containers/<id>/watch`.

## restic (`restic/`)

- Runs in the `restic` container; `crond` calls `backup.sh` every 2 h, with `--ha` daily at 02:00 and `--push` (copy to the Pi's WD My Cloud over SFTP) Monday and Thursday at 02:00. Logs: `docker logs restic`.
- `backup.sh` is bind-mounted and bash reads it while running. Check `docker exec restic pgrep -fl 'backup.sh|restic'` before editing it. While a run is in progress, write the new version to a temporary file and `mv` it over `backup.sh` (new inode), never edit in place, and delete the temporary file.
- A run takes ~2 h; overlapping runs exit with "Another backup is already running", which also skips a scheduled push.
- Keep `--ignore-inode`: the CIFS shares have unstable inode numbers, without it every file looks changed and runs take 4-7 h.
- Manual push: `docker exec -d restic sh -c '/home/thome/homelab-compose/restic/backup.sh --push > /proc/1/fd/1 2>&1'` (backup, prune, then copy).
- "repository is already locked" with an old lock date means a stale lock (container restarted mid-run): `docker exec restic restic unlock` removes only stale locks.
- `backup.sh` writes `/data/backups/snapshots/{nas,rpi}.json` and `/data/grafana/textfile/*.prom`, read by the homepage Backups and Storage cards.

## homepage (`homepage/`)

- `static/` and `app.py` are baked into the image: rebuild with `docker compose up -d --build homepage`. `config.yml` is mounted: `docker restart homepage` is enough.

## BookStack (`book-stack/`)

- The OSCP site requires Authentik login. For authorized local maintenance, the app is in `/app/www` inside `oscp-bookstack`, with persistent config at `/config`. Bootstrap PHP with `vendor/autoload.php`, `bootstrap/app.php`, then the console kernel; inspect the current models and methods before using them.
- Use native `PageRepo::update` under the appropriate existing user, not direct SQL updates, to retain revisions, search indexing and reference updates. Use it for renames too, since titles can change page slugs and links.
- Before changing pages, save a private backup outside the repo (e.g. `/config/backups`, files mode `0600`), check for edit drafts and concurrent changes, and preview the result. Wrap related updates and their validation in a database transaction.
- BookStack regenerates HTML IDs unless they start with `bkmrk`. Give imported elements unique `bkmrk-...` IDs; otherwise inserted examples can take existing bookmark IDs and break links. Verify existing bookmarks and their text after native HTML formatting.
- When integrating notes into a course, distribute code and explanations into the matching sections without overwriting existing content. Preserve the source page unchanged unless explicitly asked otherwise; verify every source code block was copied and unrelated pages remain unchanged.
- Use topic-specific titles for command collections (e.g. “Web Applications and Client-Side Attacks Commands”), since there may be several such pages. Do not silently correct source snippets or execute them while reorganizing documentation.

## Raspberry Pi (`rpi/`)

- Setup and services: [rpi/README.md](rpi/README.md). SSH as `thome` (passwordless sudo) with `restic/secrets/rpi-ssh-key`: passphrase-protected, load it into a temporary `ssh-agent` with `SSH_ASKPASS` reading `restic/secrets/rpi-ssh-passphrase`, `UserKnownHostsFile=restic/secrets/rpi-known-hosts`; host from `RPI_REPOSITORY` in `restic/.env`. Kill the agent afterwards.
- The Pi has its own checkout of this repo with local uncommitted edits: change files there with targeted edits, never overwrite them. It uses `sudo docker compose`.
- The WD My Cloud is a CIFS share mounted on the Pi at `/mnt/wdmycloud` (`/etc/fstab` there); its password is kept in `restic/secrets/wdmycloud-password` (not used by restic itself). Known issue, still to fix: the mount is unreliable, especially after a reboot, which breaks the `--push` copy and the homepage Storage card.
