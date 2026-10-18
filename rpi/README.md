# RPi Quick Setup

## Tailscale IPs

- rpi: 100.81.37.26
- thome-server: 100.104.147.1

## One-time install

```bash
sudo apt update
sudo apt install -y docker-compose
```

## Home Assistant (local only)

- URL: http://127.0.0.1:8123
- Config path: /data/homeassistant/config

Start or update:

```bash
sudo docker-compose up -d
```

## Portainer Agent

Start or update:

```bash
sudo docker-compose up -d
```

## Uptime Kuma (external watchdog, Tailscale only)

- URL: http://100.81.37.26:3001
- Data path: /data/uptime-kuma

Start or update:

```bash
sudo docker-compose up -d
```

Monitors (group "Thome Server", checks the server from outside its network; Discord notification copied from the main instance):

- thome-server ping: 100.104.147.1
- https://thomega.fr, https://auth.thomega.fr, https://photo.thomega.fr, https://nextcloud.thomega.fr, https://fanfare-makabes.fr
- Main Uptime Kuma: http://100.104.147.1:3001
