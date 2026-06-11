sudo nano /etc/netplan/50-cloud-init.yaml

```js
network:
  version: 2
  ethernets:
    enp34s0:  // Your internet name
      dhcp4: false
      addresses:
        - 192.168.1.5/24
      routes:
        - to: default
          via: 192.168.0.1
      nameservers:
        addresses:
          - 1.1.1.1 // Otherwise broken
      optional: true
```

sudo nano /data/pihole/etc-dnsmasq.d/dnsmasq-dhcp.conf

sudo netplan apply
=> Enter

ip addr show enp34s0
ip route
cat /etc/resolv.conf

ping 192.168.0.1
ping 1.1.1.1
ping google.com
