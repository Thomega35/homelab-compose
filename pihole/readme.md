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
        - 192.168.1.5/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses:
          - 1.1.1.1  # Must be an external DNS, not Pi-hole, to avoid a boot-time chicken-and-egg problem
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

ping 192.168.1.1
ping 1.1.1.1
ping google.com

docker exec pihole dig @127.0.0.1 auth.thomega.fr +short
```
