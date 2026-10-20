# Pi-hole Setup Notes

## Host network config

`sudo nano /etc/netplan/50-cloud-init.yaml`

```yaml
network:
  version: 2
  ethernets:
    enp34s0:  # Your interface name
      dhcp4: false
      addresses:
        - <SERVER_IP>/24
      routes:
        - to: default
          via: <LAN_GATEWAY>
      nameservers:
        addresses:
          - <PIHOLE_IP>
      optional: true
```

```sh
sudo netplan apply
```

## Diagnostics

```sh
ip addr show enp34s0
ip route
cat /etc/resolv.conf

ping <LAN_GATEWAY>
ping 1.1.1.1
ping google.com

docker exec pihole dig @127.0.0.1 auth.thomega.fr +short
```
