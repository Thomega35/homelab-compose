# homelab-compose

Simple Docker Compose files for my homelab services.

## Services

- `authentik/`: Identity provider and forward-auth middleware for Traefik
- `genealogy/`: Gramps Web (multi-tree) with Authentik OIDC login
- `grafana/`: Observability stack (Grafana, Prometheus, Loki, Alloy, Node Exporter)
- `homeassistant/`: Home Assistant
- `homepage/`: Custom homepage on `thomega.fr` (service status, server/NAS/Pi storage with Immich & backup share, Minecraft & Palworld overview) behind Authentik
- `immich-app/`: Immich stack (server, ML, Redis, Postgres)
- `lan-orangutan/`: LAN Orangutan network device scanner (host network)
- `meshcentral/`: MeshCentral remote device management
- `book-stack/`: BookStack OSCP documentation with native Authentik OIDC and MariaDB
- `nextcloud/`: Nextcloud AIO master container
- `openspeedtest/`: OpenSpeedTest self-hosted speed test server
- `pihole/`: Pi-hole DNS + DHCP (macvlan)
- `portainer/`: Portainer CE container management UI
- `qdirstat/`: QDirStat disk usage analyzer (host `/` mounted read-only) behind Traefik + Authentik
- `rustdesk/`: RustDesk self-hosted server (hbbs + hbbr)
- `screeps/`: Screeps relay UI behind Traefik + Authentik
- `super-productivity/`: Super Productivity + WebDAV sync behind Traefik
- `traefik/`: Reverse proxy + TLS (Let's Encrypt DNS challenge with Cloudflare) + Cloudflare DDNS
- `uptime-kuma/`: Uptime Kuma monitoring dashboard
- `vscode/`: code-server exposed behind Traefik + Authentik

## Dependency graph

```mermaid
graph LR
    Internet((Internet)) -->|80/443| Traefik
    CF[Cloudflare DNS / ACME] <-->|DDNS + DNS challenge| Traefik

    subgraph Edge
        Traefik
        Authentik
        AKDB[(authentik Postgres)]
        Authentik --> AKDB
    end

    Traefik -.->|docker.sock labels| Docker{{Docker socket}}

    subgraph ForwardAuth["Authentik forward-auth (Traefik middleware)"]
        Homepage
        TraefikDash[Traefik dashboard]
        Prometheus
        Kiosk[Immich Kiosk]
        Zigbee2mqtt[Zigbee2MQTT]
        Qdirstat[QDirStat]
        Vscode[code-server]
        Screeps[Screeps]
        SuperProd[Super Productivity]
        UptimeKuma[Uptime Kuma]
        WUD
        Bentopdf[BentoPDF]
        LanOrangutan[LAN Orangutan]
        Pihole[Pi-hole]
    end

    subgraph OIDC["Authentik OAuth2 / OIDC (app login)"]
        Grafana
        Immich
        Nextcloud
        HomeAssistant[Home Assistant]
        Portainer
        Dawarich
        Excalidash
        Meshcentral[MeshCentral]
        Genealogy[Gramps Web]
        BookStack[BookStack OSCP docs]
    end

    subgraph Public["Traefik only (no Authentik)"]
        Openspeedtest[OpenSpeedTest]
        BlueMap
    end

    Traefik --> ForwardAuth
    Traefik --> OIDC
    Traefik --> Public
    ForwardAuth -->|forward-auth| Authentik
    OIDC -->|OAuth2 / OIDC| Authentik

    subgraph Observability
        Loki
        Alloy
        NodeExp[Node Exporter]
        Cadvisor[cAdvisor]
    end

    Grafana --> Prometheus
    Grafana --> Loki
    Alloy -->|push logs| Loki
    Prometheus -->|scrape| NodeExp
    Prometheus -->|scrape over Tailscale| RpiNodeExp[Pi Node Exporter]
    Prometheus -->|scrape| Cadvisor
    Prometheus -->|scrape| Traefik
    Prometheus -->|scrape| Authentik
    Prometheus -->|scrape| Dawarich
    Prometheus -->|scrape| Grafana

    subgraph Data["Per-app data services"]
        ImmichDB[(Immich Postgres + Redis)]
        ImmichML[Immich ML]
        DawarichDB[(Dawarich DB)]
        NextcloudDB[(Nextcloud Postgres + Redis)]
        GrampsRedis[(Gramps Redis)]
        ExcaliBack[Excalidash backend]
    end

    Immich --> ImmichDB
    Immich --> ImmichML
    Kiosk --> Immich
    Zigbee2mqtt -->|MQTT| HomeAssistant
    Dawarich --> DawarichDB
    Nextcloud --> NextcloudDB
    Genealogy --> GrampsRedis
    Excalidash --> ExcaliBack

    subgraph Games["Game servers"]
        Palworld
        PalBot[Palworld whitelist bot]
        PalProxy[Palworld docker-proxy]
        Minecraft
    end

    BlueMap -.->|served by| Minecraft
    PalBot --> Palworld
    PalBot --> PalProxy
    PalProxy -.-> Docker

    Homepage -->|PROMETHEUS_URL| Prometheus
    Homepage -->|LOKI_URL| Loki
    Homepage -->|REST API| Palworld
    Homepage -->|status ping| Minecraft
    Homepage --> HPProxy[Homepage docker-proxy]
    HPProxy -.-> Docker

    Restic -->|pg_dumpall of Postgres containers + volume backup| Docker
    Restic -->|Immich / repo sizes, textfile| NodeExp
    UptimeKuma -.->|monitors| ForwardAuth
    UptimeKuma -.->|monitors| OIDC
    WUD -.->|image updates| Docker
    Portainer -.-> Docker

    Rustdesk[RustDesk hbbs] --> Hbbr[RustDesk hbbr]
```

## Authentication

Every web app goes through Traefik. Authentik (`auth.thomega.fr`) protects them in one of two ways:

| Mode | Apps |
| --- | --- |
| **Forward-auth** (Traefik `authentik-auth@docker` middleware + Authentik proxy provider, login before the app loads) | Homepage, Traefik dashboard, Prometheus, Immich Kiosk, Zigbee2MQTT, BentoPDF, Screeps, Super Productivity, Uptime Kuma, What's Up Docker, Pi-hole (`/admin/img` + `/api` bypass), LAN Orangutan, QDirStat, VS Code |
| **OAuth2 / OIDC** (Authentik OAuth2 provider, "Login with Authentik" in the app) | Grafana, Immich, Nextcloud, Home Assistant, Portainer, Dawarich, Excalidash, MeshCentral, Gramps Web, BookStack |
| **None** (public) | OpenSpeedTest, BlueMap (Minecraft map) |

Not web apps: RustDesk, Minecraft, Palworld, Restic. The Pi services (`rpi/`) are LAN-only.

Most OIDC clients are configured in each app's UI (Immich, Nextcloud, Home Assistant, Portainer). The `.env`-based clients are Grafana, Dawarich, Excalidash, BookStack, and Gramps Web; MeshCentral uses `config.json`.




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

- Homepage: `https://thomega.fr`
- Gramps Web: `https://gen.thomega.fr`
- Grafana: `https://grafana.thomega.fr`
- Prometheus: `https://prometheus.thomega.fr`
- Home Assistant: `https://home.thomega.fr`
- Immich: `https://photo.thomega.fr`
- LAN Orangutan: `https://lano.thomega.fr`
- Nextcloud AIO: `https://nextcloud.thomega.fr`
- OpenSpeedTest: `https://speed.thomega.fr`
- Portainer: `https://portainer.thomega.fr`
- QDirStat: `https://qdirstat.thomega.fr`
- RustDesk server: `https://rust.thomega.fr`
- Screeps: `https://screeps.thomega.fr`
- Super Productivity: `https://sp.thomega.fr`
- Traefik dashboard: `https://traefik.thomega.fr`
- Authentik: `https://auth.thomega.fr`
- MeshCentral: `https://mesh.thomega.fr`
- BookStack (OSCP): `https://oscp.thomega.fr`
- Pi-hole: `https://hole.thomega.fr`
- Uptime Kuma: `https://upk.thomega.fr`
- VS Code: `https://vscode.thomega.fr`

## Notes

- `traefik/` creates the shared Docker network `traefik-net`; start this stack before other services that attach to it.
- `homepage/` also joins `grafana_monitoring` (Loki) and `palworld_default` (Palworld REST API): start `grafana/` and `palworld/` first. Services and game settings are in `homepage/config.yml`.
- `pihole/` uses macvlan with a static IP (`PIHOLE_IP`) and wildcard DNS for `*.thomega.fr` routed to the server (`SERVER_IP`); set them in `pihole/.env`.
