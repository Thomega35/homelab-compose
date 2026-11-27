const fs = require("node:fs");
const path = require("node:path");

const mountsQuery = '((count(node_filesystem_size_bytes{job="node-exporter",fstype="cifs",mountpoint=~"/mnt/nas|/mnt/nas-images"} > 0) or vector(0)) == bool 2) * ((min(up{job="node-exporter"}) or vector(0)) == bool 1)';
const restartSeries = 'homelab_container_restart_count_total{job="node-exporter",container!="reliability-restart-test-20261127"}';
const restartsQuery = `((max(max_over_time(${restartSeries}[10m]) - min_over_time(${restartSeries}[10m])) or vector(0)) < bool 3) * ((count(${restartSeries}) or vector(0)) > bool 0) * ((min(up{job="node-exporter"}) or vector(0)) == bool 1) * ((time() - (max(homelab_container_restarts_collected_timestamp_seconds{job="node-exporter"}) or vector(0))) < bool 120)`;
const prometheusHealthy = 'status = "success" and $count(data.result) = 1 and data.result[0].value[1] = "1"';

function discordEmojiSettings(notification) {
    const serviceUrl = notification.disableUrl ? "" : "\nService: {{ hostnameOrURL }}";
    return {
        ...notification,
        applyExisting: false,
        discordMessageFormat: "custom",
        discordUseMessageTemplate: true,
        discordMessageTemplate: `{% capture content %}{% if heartbeatJSON == nil %}🧪 **TEST** — {{ msg }}{% else %}{% if heartbeatJSON.status == 0 %}🚨 **DOWN**{% else %}✅ **UP**{% endif %} — **{{ name }}**
Time ({{ heartbeatJSON.timezone | default: "UTC" }}): {{ heartbeatJSON.localDateTime | default: heartbeatJSON.time }}
{% if heartbeatJSON.lastDownTime %}Previously down: {{ heartbeatJSON.lastDownTime }}
{% endif %}{% if heartbeatJSON.ping != nil %}Ping: {{ heartbeatJSON.ping }} ms
{% endif %}Details: {{ heartbeatJSON.msg | default: msg }}${serviceUrl}{% endif %}{% endcapture %}{{ content | strip | truncate: 2000 }}`,
    };
}

function backupHealthy(name) {
    return `(
        $now := $millis();
        $repo := backups[name = ${JSON.stringify(name)}];
        $latest := $max($repo.snapshots.time);
        $type(updated) = "number" and updated <= $now and $now - updated < 60000
        and $count($repo) = 1 and $type($repo.max_age_hours) = "number" and $repo.max_age_hours > 0
        and $type($latest) = "number" and $latest <= $now
        and $now - $latest < $repo.max_age_hours * 3600000
    )`;
}

const probes = [
    {
        name: "[Reliability] Authentik login flow",
        description: "Checks the anonymous login-flow API reaches the identification stage. Does not test a username/password or OIDC round trip.",
        url: "https://auth.thomega.fr/api/v3/flows/executor/default-authentication-flow/",
        jsonPath: 'component = "ak-stage-identification"',
    },
    {
        name: "[Reliability] NAS mounts",
        description: "Both NAS paths must report nonempty CIFS filesystems and the host exporter must be up.",
        url: "http://prometheus:9090/api/v1/query?query=" + encodeURIComponent(mountsQuery),
        jsonPath: prometheusHealthy,
    },
    {
        name: "[Reliability] NAS backup freshness",
        description: "Uses the homepage NAS backup-age limit (currently 3 hours); missing snapshots or homepage state older than 60 seconds fail.",
        url: "http://homepage:8080/api/state",
        jsonPath: backupHealthy("NAS"),
    },
    {
        name: "[Reliability] Off-site backup freshness",
        description: "Uses the homepage off-site backup-age limit (currently 100 hours); missing snapshots or homepage state older than 60 seconds fail.",
        url: "http://homepage:8080/api/state",
        jsonPath: backupHealthy("WDMyCloud Abbaye"),
    },
    {
        name: "[Reliability] Container restart loops",
        description: "Fails when Docker's automatic restart counter rises by 3 within 10 minutes, or restart collection is missing/stale for 120 seconds. Manual docker restart does not increment this counter.",
        url: "http://prometheus:9090/api/v1/query?query=" + encodeURIComponent(restartsQuery),
        jsonPath: prometheusHealthy,
    },
];

async function apply({ testNotification = false, discordEmojis = false, notificationsOnly = false } = {}) {
    process.umask(0o077);
    const managedProbes = notificationsOnly ? [] : probes;
    const sqlite = require("/app/node_modules/@louislam/sqlite3");
    const { io } = require("/app/node_modules/socket.io-client");
    const User = require("/app/server/model/user");
    const { evaluateJsonQuery } = require("/app/server/jsonata-sandbox");
    const db = await new Promise((resolve, reject) => {
        const connection = new sqlite.Database("/app/data/kuma.db", sqlite.OPEN_READONLY, (error) => {
            if (error) reject(error);
            else resolve(connection);
        });
    });
    const rows = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (error, result) => error ? reject(error) : resolve(result));
    });
    let socket;
    try {
        const users = await rows("SELECT id, username, password FROM user WHERE active = 1");
        const notifications = await rows("SELECT id, user_id, config FROM notification WHERE active = 1 AND is_default = 1");
        if (users.length !== 1 || notifications.length !== 1 || notifications[0].user_id !== users[0].id) {
            throw new Error("Expected one active Kuma user and one default notification owned by that user.");
        }
        let notification = JSON.parse(notifications[0].config);
        if (notification.type !== "discord") {
            throw new Error("The default notification is not the approved Discord channel.");
        }
        for (const probe of managedProbes) {
            const response = await fetch(probe.url, { signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error(`${probe.name}: HTTP ${response.status}`);
            const result = await evaluateJsonQuery(await response.json(), probe.jsonPath, "==", "true");
            if (!result.status) throw new Error(`${probe.name}: preflight condition failed.`);
        }

        const directory = "/app/data/backups/reliability";
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        const backupPath = path.join(directory, `kuma-before-alerts-${Date.now()}.db`);
        const backup = db.backup(backupPath);
        try {
            await new Promise((resolve, reject) => backup.step(-1, (error) => error ? reject(error) : resolve()));
        } finally {
            await new Promise((resolve, reject) => backup.finish((error) => error ? reject(error) : resolve()));
        }
        fs.chmodSync(backupPath, 0o600);
        console.log("Saved a private online SQLite backup before editing monitors.");

        const settings = await rows("SELECT value FROM setting WHERE key = 'jwtSecret'");
        if (settings.length !== 1) throw new Error("Kuma JWT setting is missing.");
        socket = io("http://127.0.0.1:3001", { transports: ["websocket"], reconnection: false, autoConnect: false });
        await new Promise((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("connect_error", reject);
            socket.connect();
        });
        const call = (event, ...args) => new Promise((resolve, reject) => {
            socket.timeout(20000).emit(event, ...args, (error, response) => {
                if (error) reject(new Error(`Kuma ${event} timed out.`));
                else if (!response?.ok) reject(new Error(`Kuma ${event} failed.`));
                else resolve(response);
            });
        });
        await call("loginByToken", User.createJWT(users[0], settings[0].value));
        if (discordEmojis) {
            notification = discordEmojiSettings(notification);
            const saved = await call("addNotification", notification, notifications[0].id);
            if (saved.id !== notifications[0].id) throw new Error("Kuma saved an unexpected notification ID.");
            console.log("Updated the shared Discord template: outage, recovery and test emojis.");
        }
        const defaults = {
            type: "json-query", parent: null, method: "GET", active: true,
            interval: 20, retryInterval: 20, maxretries: 3, resendInterval: 0,
            timeout: 10, maxredirects: 5, accepted_statuscodes: ["200"],
            ignoreTls: false, upsideDown: false, authMethod: null,
            saveResponse: false, saveErrorResponse: false, responseMaxLength: 1024,
            jsonPathOperator: "==", expectedValue: "true",
            kafkaProducerBrokers: [], kafkaProducerSaslOptions: { mechanism: "None" },
            rabbitmqNodes: [], conditions: [],
        };
        const result = [];
        for (const probe of managedProbes) {
            const existing = await rows("SELECT id, user_id, type FROM monitor WHERE name = ?", [probe.name]);
            if (existing.length > 1 || (existing.length === 1 && (existing[0].user_id !== users[0].id || existing[0].type !== "json-query"))) {
                throw new Error(`${probe.name}: existing monitor conflicts with managed configuration.`);
            }
            let id;
            if (existing.length === 1) {
                id = existing[0].id;
                const current = (await call("getMonitor", id)).monitor;
                await call("editMonitor", {
                    ...current, ...defaults, ...probe,
                    notificationIDList: { ...current.notificationIDList, [notifications[0].id]: true },
                });
            } else {
                const added = await call("add", {
                    ...defaults, ...probe, notificationIDList: { [notifications[0].id]: true },
                });
                id = added.monitorID;
            }
            result.push({ id, name: probe.name });
            console.log(`Configured ${probe.name} (monitor ${id}).`);
        }
        if (testNotification) {
            await call("testNotification", { ...notification, name: "[TEST] Homelab reliability alerts - no production outage" });
            console.log("Kuma confirmed delivery of the approved labelled Discord test.");
        }
        return result;
    } finally {
        if (socket) socket.disconnect();
        await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    }
}

module.exports = { probes, backupHealthy, mountsQuery, restartsQuery, discordEmojiSettings, apply };
if (require.main === module) {
    apply({
        testNotification: process.argv.includes("--test-notification"),
        discordEmojis: process.argv.includes("--discord-emojis"),
        notificationsOnly: process.argv.includes("--discord-emojis"),
    }).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
