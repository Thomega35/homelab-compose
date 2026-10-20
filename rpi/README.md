# RPi Quick Setup

## Tailscale IPs

Set the Pi's IP as `TAILSCALE_IP` in each stack's `.env` (copy from `.env.dist`).

- rpi: `<RPI_TAILSCALE_IP>`
- thome-server: `<SERVER_TAILSCALE_IP>`

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

### Mosquitto + Zigbee2MQTT (same compose as Home Assistant)

- Mosquitto: mqtt://<RPI_TAILSCALE_IP>:1883 (anonymous, Tailscale only), data in /data/mosquitto
- Zigbee2MQTT UI: http://<RPI_TAILSCALE_IP>:8080, data in /data/zigbee2mqtt
- Dongle: Sonoff Zigbee 3.0 USB Dongle Plus V2 (`ember` adapter), mapped from `/dev/serial/by-id/usb-Itead_Sonoff_...` to `/dev/ttyUSB0`

First install, copy the Mosquitto config before starting:

```bash
sudo mkdir -p /data/mosquitto/config
sudo cp mosquitto/mosquitto.conf /data/mosquitto/config/
```

Then:

- Zigbee2MQTT: finish the onboarding on port 8080 (MQTT server and serial port are prefilled), enable the Home Assistant integration.
- Home Assistant: Settings > Devices & services > Add integration > MQTT, broker `mosquitto`, port `1883`.

### Linked to thome-server Home Assistant

The Pi is a remote instance of the main HA on thome-server ([Remote Home Assistant](https://github.com/custom-components/remote_homeassistant), installed via HACS on both).

- Pi: `remote_homeassistant:` block in `configuration.yaml`, long-lived token "HA thome-server" (Thomega user)
- thome-server: `remote_homeassistant` instance `<RPI_TAILSCALE_IP>:8123` in `/data/Homeassistant/core/configuration.yaml`, token in `secrets.yaml` (`rpi_homeassistant_token`)
- Pi entities appear on the server prefixed with `rpi_` (zone, person, sun excluded); services called on them are forwarded to the Pi

## Portainer Agent

Start or update:

```bash
sudo docker-compose up -d
```

## Uptime Kuma (external watchdog, Tailscale only)

- URL: http://<RPI_TAILSCALE_IP>:3001
- Data path: /data/uptime-kuma

Start or update:

```bash
sudo docker-compose up -d
```

Monitors (group "Thome Server", checks the server from outside its network; Discord notification copied from the main instance):

- thome-server ping: `<SERVER_TAILSCALE_IP>`
- https://thomega.fr, https://auth.thomega.fr, https://photo.thomega.fr, https://nextcloud.thomega.fr, https://fanfare-makabes.fr
- Main Uptime Kuma: http://<SERVER_TAILSCALE_IP>:3001
