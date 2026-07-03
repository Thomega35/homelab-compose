# RPi Quick Setup

## Tailscale IPs

- rpi: 100.81.37.26
- thome-server: 100.104.147.17

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
