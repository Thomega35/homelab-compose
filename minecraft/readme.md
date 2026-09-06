# Minecraft Bridge Stack Configuration Guide

This guide documents the multi-platform chat relay and mapping setup connecting Minecraft (Paper), BlueMap, KOKOTO WebChat (KWC), and DiscordSRV through a Traefik reverse proxy.

---

## 🏗️ Architecture Overview

```text
                      ┌───────────────────────────┐
                      │   minecraft.thomega.fr    │
                      └─────────────┬─────────────┘
                                    │
                           ┌────────┴────────┐
                    (Port 443 / HTTPS via Traefik)
                           │                 │
            PathPrefix: /  │                 │ PathPrefix: /api, /kokoto, /chat
                           ▼                 ▼
                    ┌─────────────┐   ┌─────────────┐
                    │   BlueMap   │   │ KOKOTO Web  │
                    │   (:8100)   │   │   (:8899)   │
                    └──────┬──────┘   └──────┬──────┘
                           │                 │
                           └────────┬────────┘
                                    │
                         ┌──────────┴──────────┐
                         │  Paper Minecraft    │
                         │  (Async Chat Event) │
                         └──────────┬──────────┘
                                    │
                           ┌────────┴────────┐
                           │   DiscordSRV    │
                           └────────┬────────┘
                                    │
                                    ▼
                         ┌───────────────────┐
                         │  Discord Channel  │
                         └───────────────────┘
```

---

## 🛠️ Docker & Infrastructure Configuration

### Service Layout

The core runtime is a Paper-based Minecraft server running inside Docker, with BlueMap and KOKOTO WebChat exposed on the same public hostname through Traefik. The container is attached to the external Traefik network so routing can be handled without exposing raw ports directly to the internet.

### Port Mappings & Traefik Routing Rules

The stack is configured to route external HTTPS traffic based on hostname and path:

- BlueMap UI: Host `minecraft.thomega.fr` on port `8100`, priority `1`
- KOKOTO WebChat API/WebSocket: Host `minecraft.thomega.fr` matching `/api`, `/kokoto`, or `/chat` on port `8899`, priority `10`

---

## 🔌 Plugin 1: DiscordSRV (`config.yml`)

Path: `/data/minecraft/plugins/DiscordSRV/config.yml`

### Key Adjustments Made

These settings are required so messages originating from non-player virtual entities, such as KOKOTO web users, can still be relayed to Discord without being discarded by the Bukkit event pipeline.

- `DiscordChatChannelIsCancelledFilter: false` — Prevents DiscordSRV from ignoring already-processed chat events.
- `DiscordChatChannelInGameChatMustBeFromPlayer: false` — Allows virtual or web-originated players to relay messages to Discord.
- `DiscordChatChannelPriority: "MONITOR"` — Ensures DiscordSRV is one of the last listeners to read the event.
- `Experiment_DiscordChatMessageFromExtFullPlayerSync: true` — Enables broader metadata compatibility for external/Web users.

```yaml
BotToken: "YOUR_DISCORD_BOT_TOKEN"
Channels: {"global": "1546142807083851846"}
DiscordConsoleChannelId: "276766539808505862"

# External Player Synchronization Settings
Experiment_DiscordChatMessageFromExtFullPlayerSync: true

# Chat Filtering Adjustments (Required for Web-to-Discord Relay)
DiscordChatChannelIsCancelledFilter: false
DiscordChatChannelInGameChatMustBeFromPlayer: false
DiscordChatChannelPriority: "MONITOR"

DiscordChatChannelDiscordToMinecraft: true
DiscordChatChannelMinecraftToDiscord: true
```

---

## 🔌 Plugin 2: KOKOTO WebChat (`config.yml`)

Path: `/data/minecraft/plugins/KOKOTO-WebChat/config.yml`

### Key Adjustments Made

- `enabled: true` under `discordsrv` — Connects KOKOTO WebChat directly to DiscordSRV.
- `web-socket.url` — Points to `wss://minecraft.thomega.fr/api/ws` through Traefik.
- `adapters.bluemap.api-base-url` — Points the embedded BlueMap integration to the same public host.
- `http.path-prefix: "/api"` and `public-prefix: "/chat"` — Aligns the web UI and API routes with Traefik path routing.

```yaml
config-version: "5.2.0"
enabled: true

web-socket:
  url: "wss://minecraft.thomega.fr/api/ws"

http:
  host: "0.0.0.0"
  port: 8899
  path-prefix: "/api"
  public-prefix: "/chat"
  cors-origin: "*"

frontend:
  standalone:
    enabled: true
    path: "/"
    api-base-url: ""

adapters:
  bluemap:
    enabled: true
    auto-install: true
    auto-patch-webapp-conf: true
    api-base-url: "https://minecraft.thomega.fr/api"

# DiscordSRV Native Integration Block
discordsrv:
  enabled: true
  channel: "global"
  web-to-discord: true
  game-relay-mode: "discordsrv"
  discord-to-web: true
  ignore-bot-messages: true
  suppress-game-echo: true
  suppress-game-echo-seconds: 5
  send-web-user-chat-to-discord: true
  send-web-guest-chat-to-discord: false
  send-web-admin-chat-to-discord: true
  append-web-emoji-links: true
  append-game-emoji-links: true
  max-emoji-links-per-message: 4
  web-to-discord-format: "[Web] {sender}: {message}"
  game-relay-format: "[{server}] {sender}: {message}"
  discord-to-web-sender-format: "Discord:{sender}"
  discord-to-web-message-format: "{message}"
```

### KOKOTO behavior summary

This setup provides three message flows:

1. In-game chat -> Minecraft server -> DiscordSRV -> Discord channel
2. Web chat via KOKOTO -> DiscordSRV -> Discord channel
3. Discord messages -> DiscordSRV -> Minecraft chat / web chat relay

This makes the web client behave like an extension of the game while still preserving a clean mapping layer over BlueMap.
