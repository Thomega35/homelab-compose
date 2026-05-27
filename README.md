# homelab-compose

Simple Docker Compose files of  my homelab services.

## Services

- `grafana/`: observability stack (Grafana, Prometheus, Loki, Alloy, Node Exporter)
- `homeassistant/`: Home Assistant container
- `immich-app/`: Immich stack (server, ML, Redis, Postgres)
- `nextcloud/`: Nextcloud AIO master container
- `watchtower/`: auto-update running containers

## Requirements

- Docker + Docker Compose v2
- Required host folders must exist

## Quick start

1. Go to a stack folder (`grafana`, `homeassistant`, `immich-app`, `nextcloud`, or `watchtower`).
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
- Nextcloud AIO: http://<host>:6194
