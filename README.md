# homelab-compose

Simple Docker Compose files for my homelab services.

## Services

- `authentik/`: Identity provider and forward-auth middleware for Traefik
- `excalidraw/`: Excalidraw collaborative whiteboard (app + storage + room + MongoDB)
- `grafana/`: Observability stack (Grafana, Prometheus, Loki, Alloy, Node Exporter)
- `homeassistant/`: Home Assistant
- `immich-app/`: Immich stack (server, ML, Redis, Postgres)
- `meshcentral/`: MeshCentral remote device management
- `nextcloud/`: Nextcloud AIO master container
- `openspeedtest/`: OpenSpeedTest self-hosted speed test server
- `pihole/`: Pi-hole DNS + DHCP (macvlan)
- `portainer/`: Portainer CE container management UI
- `rustdesk/`: RustDesk self-hosted server (hbbs + hbbr)
- `super-productivity/`: Super Productivity + WebDAV sync behind Traefik
- `traefik/`: Reverse proxy + TLS (Let's Encrypt DNS challenge with Cloudflare) + Cloudflare DDNS
- `uptime-kuma/`: Uptime Kuma monitoring dashboard
- `vscode/`: code-server exposed behind Traefik + Authentik

## Requirements

- Docker + Docker Compose v2
- Valid `.env` values for each stack that needs secrets/tokens

## Quick start

1. Go to a stack folder (`authentik`, `grafana`, `homeassistant`...).
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

- Grafana: `https://grafana.thomega.fr`
- Prometheus: `https://prometheus.thomega.fr`
- Home Assistant: `https://home.thomega.fr`
- Immich: `https://photo.thomega.fr`
- Nextcloud AIO: `https://nextcloud.thomega.fr`
- OpenSpeedTest: `https://speed.thomega.fr`
- Portainer: `https://portainer.thomega.fr`
- RustDesk server: `https://rust.thomega.fr`
- Super Productivity: `https://sp.thomega.fr`
- Traefik dashboard: `https://traefik.thomega.fr`
- Authentik: `https://auth.thomega.fr`
- Excalidraw: `https://draw.thomega.fr`
- MeshCentral: `https://mesh.thomega.fr`
- Pi-hole: `https://hole.thomega.fr`
- Uptime Kuma: `https://upk.thomega.fr`
- VS Code: `https://vscode.thomega.fr`

## Notes

- `traefik/` creates the shared Docker network `traefik-net`; start this stack before other services that attach to it.
- `pihole/` uses macvlan with static IP `192.168.1.6` and wildcard DNS for `*.thomega.fr` routed to `192.168.1.5`.
