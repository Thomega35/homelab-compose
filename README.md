# homelab-compose

Simple Docker Compose files of  my homelab services.

## Services

- `grafana/`: observability stack (Grafana, Prometheus, Loki, Alloy, Node Exporter)
- `homeassistant/`: Home Assistant container
- `immich-app/`: Immich stack (server, ML, Redis, Postgres)
- `nginx/`: Nginx reverse proxy with Let's Encrypt (Cloudflare DNS challenge)
- `nextcloud/`: Nextcloud AIO master container
- `watchtower/`: auto-update running containers

## Requirements

- Docker + Docker Compose v2
- Required host folders must exist

## Quick start

1. Go to a stack folder (`grafana`, `homeassistant`, `immich-app`, `nginx`, `nextcloud`, or `watchtower`).
2. Create required `.env`.
3. Start the stack.
4. Open its URL.

Commands:

```bash
cd <stack-folder>
cat .env.dist > .env
docker compose up -d
docker compose ps
docker compose logs -f
```

## URLs

- Grafana: http://<host>:3000
- Prometheus: http://<host>:9090
- Loki API: http://<host>:3100
- Home Assistant: http://<host>:8123
- Immich: http://<host>:2283
- Nginx HTTPS: https://<your-domain>
- Nextcloud AIO: http://<host>:6194

## Nginx + Let's Encrypt (Cloudflare DNS)

1. `cat cloudflare.ini.dist > cloudflare.ini` and put your Cloudflare API token.
2. Restrict file permissions if needed (`chmod 600 nginx/config/dns-conf/cloudflare.ini`).
3. Start the stack:

```bash
cd nginx
cat .env.dist > .env
docker compose up -d
```
