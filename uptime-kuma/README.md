# Reliability alerts

Five `[Reliability]` JSON-query monitors use the existing default Discord
notification in Uptime Kuma. They check every 20 seconds and allow three retries
before reporting an outage. Recovery notifications use Kuma's normal behavior;
repeated outage reminders are disabled.

| Monitor | Healthy condition |
| --- | --- |
| Authentik login flow | The anonymous default authentication flow API returns HTTP 200 and the identification stage. |
| NAS mounts | Both `/mnt/nas` and `/mnt/nas-images` report nonempty CIFS filesystems, and the host exporter is up. |
| NAS backup freshness | The latest snapshot is younger than the homepage limit, currently 3 hours. |
| Off-site backup freshness | The latest snapshot is younger than the homepage limit, currently 100 hours. |
| Container restart loops | No container's Docker automatic restart counter rises by 3 within 10 minutes; restart collection is present and younger than 120 seconds. |

Backup checks fail when snapshots are missing, duplicated or future-dated, or
the homepage state is at least 60 seconds old. They reuse the limits in
[homepage/config.yml](../homepage/config.yml) rather than introducing a second
backup schedule.

The Authentik probe checks login-flow availability, not credential validity or
a complete OIDC round trip. Existing HTTP and Docker monitors remain unchanged.
These alerts run on the main server; they cannot report its complete loss.
The Pi watchdog remains independent.

## Restart counters

[container-restarts.sh](../restic/container-restarts.sh) runs every minute inside
the existing restic container. It reads only Docker container names, IDs and
`RestartCount`, then atomically writes a node-exporter textfile. Failed collection
logs an error and retains the last sample; its timestamp eventually causes the
restart monitor to fail instead of silently reporting healthy.

Use Docker's restart counter, **not** cAdvisor's `container_start_time_seconds`:
controlled manual restarts did not change that metric. Manual `docker restart`
also does not increment Docker's automatic restart counter.

Counters are separated by container ID so recreating a container does not look
like a counter decrease in the same series. Prometheus compares the maximum and
minimum counter values within ten minutes, avoiding extrapolation across the
approved three-restart threshold. The disposable validation container
`reliability-restart-test-20261127` is excluded from production alerts.

The collector's cron entry is persisted in [restic/docker-compose.yml](../restic/docker-compose.yml).
It was also installed into the running container with `crontab`, without
restarting restic or interrupting its active backup.

## Applying the monitor configuration

From the repository root:

```sh
docker cp uptime-kuma/reliability.js uptime-kuma:/tmp/reliability.js
docker exec uptime-kuma node /tmp/reliability.js
docker exec uptime-kuma rm /tmp/reliability.js
```

Run only inside the main Uptime Kuma container. The script requires one active
Kuma user and one default Discord notification owned by that user. It checks
live probe responses, takes a private online SQLite backup, and creates or
updates only the five managed monitors through Kuma's native Socket.IO API.
Existing notification bindings on managed monitors are preserved. Local
administrative authentication is kept in memory; credentials are never printed
or saved by the script.

Backups are retained in `/data/uptime-kuma/backups/reliability` on the host,
with directory mode `0700` and database file mode `0600`. They contain secrets:
do not print, commit or share them.

Add `--test-notification` only with approval to send a labelled test message to
the existing Discord channel.

## Discord message style

The shared Discord notification uses a native custom template:

- 🚨 **DOWN** for outages.
- ✅ **UP** for recovery.
- 🧪 **TEST** for test messages.

This applies to every monitor attached to that notification, not only the five
reliability monitors. As approved, formatted text replaces the previous rich
embeds. It retains the service name, time, error/status details, optional ping
and service URL, respecting the URL-hiding setting when generating the template.
Messages are limited to 2,000 Unicode characters.

Use `node /tmp/reliability.js --discord-emojis` after copying the script as above
to reapply the style. This mode updates only the existing default Discord
notification through Kuma's API, preserving its webhook, transport settings and
monitor bindings. It takes a private backup and sends no test unless
`--test-notification` is also explicitly supplied.

## Validation

```sh
docker cp uptime-kuma/reliability.js uptime-kuma:/tmp/reliability.js
docker cp uptime-kuma/test-reliability.js uptime-kuma:/tmp/test-reliability.js
docker exec uptime-kuma node --test /tmp/test-reliability.js
docker exec uptime-kuma node /tmp/test-reliability.js --promql-fixtures \
  | docker exec -i prometheus sh -c 'cat > /tmp/reliability-tests.json'
docker exec prometheus promtool test rules /tmp/reliability-tests.json
docker exec uptime-kuma rm /tmp/reliability.js /tmp/test-reliability.js
docker exec prometheus rm /tmp/reliability-tests.json
docker run --rm --network none --entrypoint bash \
  --mount type=bind,src="$PWD/restic",dst=/work,readonly \
  homelab-restic:0.19.1 /work/test-container-restarts.sh
```

On 2026-11-27, predicate and PromQL tests passed, including the exact backup-age
and three-restart boundaries and missing/stale sources. An actual automatic
restart loop was detected using a disposable container; it was removed
afterwards. Applying the configuration twice retained exactly five monitors,
all reporting UP with the Discord notification attached. The private online
SQLite backup passed integrity checking, unattended cron refreshed the metrics,
and Kuma confirmed delivery of one approved, clearly labelled Discord test.
No production outage, unmount or service restart was induced.
