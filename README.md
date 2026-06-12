# homelab-compose

Simple Docker Compose files for my homelab services.

## Services

- `authentik/`: Identity provider and forward-auth middleware for Traefik
- `grafana/`: Observability stack (Grafana, Prometheus, Loki, Alloy, Node Exporter)
- `homeassistant/`: Home Assistant
- `immich-app/`: Immich stack (server, ML, Redis, Postgres)
- `nextcloud/`: Nextcloud AIO master container
- `pihole/`: Pi-hole DNS + DHCP (macvlan)
- `traefik/`: Reverse proxy + TLS (Let's Encrypt DNS challenge with Cloudflare) + Cloudflare DDNS
- `vscode/`: code-server exposed behind Traefik + Authentik

## Requirements

- Docker + Docker Compose v2
- Valid `.env` values for each stack that needs secrets/tokens

## Quick start

1. Go to a stack folder (`authentik`, `grafana`, `homeassistant`, `immich-app`, `nextcloud`, `pihole`, `traefik`, or `vscode`).
2. Create required `.env` if the stack provides a template.
3. Start the stack.
4. Open its URL.

Commands:

```bash
cd <stack-folder>
[ -f .env.dist ] && cp .env.dist .env
docker compose up -d
docker compose ps
docker compose logs -f
```

## URLs

- Grafana: `http://thomega.fr:3000`
- Prometheus: `http://thomega.fr:9090`
- Loki API: `http://thomega.fr:3100`
- Home Assistant: `http://thomega.fr:8123`
- Immich: `http://thomega.fr:2283`
- Nextcloud AIO: `http://thomega.fr:6194`
- Traefik dashboard: `https://traefik.thomega.fr`
- Authentik: `https://auth.thomega.fr`
- Pi-hole: `https://hole.thomega.fr` (or `http://thomega.fr:800`)
- VS Code: `https://vscode.thomega.fr`

## Notes

- `traefik/` creates the shared Docker network `traefik-net`; start this stack before other services that attach to it.
- `pihole/` uses macvlan with static IP `192.168.1.6` and wildcard DNS for `*.thomega.fr` routed to `192.168.1.5`.
