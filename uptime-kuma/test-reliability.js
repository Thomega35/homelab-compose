const assert = require("node:assert/strict");
const { probes, backupHealthy, mountsQuery, restartsQuery, discordEmojiSettings } = require("./reliability");

if (process.argv.includes("--promql-fixtures")) {
    const start = 'homelab_container_restart_count_total{job="node-exporter",container="test-app",id="test-id"}';
    const exporter = 'up{job="node-exporter"}';
    const collected = 'homelab_container_restarts_collected_timestamp_seconds{job="node-exporter"}';
    const nas = 'node_filesystem_size_bytes{job="node-exporter",fstype="cifs",mountpoint="/mnt/nas"}';
    const images = 'node_filesystem_size_bytes{job="node-exporter",fstype="cifs",mountpoint="/mnt/nas-images"}';
    const cases = [
        ["two restarts stay healthy", restartsQuery, [[start, "1 2 3 3"], [exporter, "1 1 1 1"], [collected, "0 60 120 180"]], 1],
        ["three restarts fail", restartsQuery, [[start, "1 2 3 4"], [exporter, "1 1 1 1"], [collected, "0 60 120 180"]], 0],
        ["missing restart metrics fail", restartsQuery, [[exporter, "1 1 1 1"], [collected, "0 60 120 180"]], 0],
        ["stale restart collector fails", restartsQuery, [[start, "1 1 1 1"], [exporter, "1 1 1 1"], [collected, "0 0 0 0"]], 0],
        ["missing collector timestamp fails", restartsQuery, [[start, "1 1 1 1"], [exporter, "1 1 1 1"]], 0],
        ["two CIFS mounts pass", mountsQuery, [[nas, "100 100 100 100"], [images, "100 100 100 100"], [exporter, "1 1 1 1"]], 1],
        ["one missing mount fails", mountsQuery, [[nas, "100 100 100 100"], [exporter, "1 1 1 1"]], 0],
        ["missing exporter fails", mountsQuery, [[nas, "100 100 100 100"], [images, "100 100 100 100"]], 0],
    ];
    console.log(JSON.stringify({
        evaluation_interval: "1m",
        tests: cases.map(([name, expr, series, value]) => ({
            name, interval: "1m",
            input_series: series.map(([series, values]) => ({ series, values })),
            promql_expr_test: [{ expr, eval_time: "3m", exp_samples: [{ labels: "{}", value }] }],
        })),
    }));
} else {
    const { test } = require("node:test");
    const { evaluateJsonQuery } = require("/app/server/jsonata-sandbox");
    const passes = async (expression, data) => (await evaluateJsonQuery(data, expression, "==", "true")).status;
    const state = (age, limit = 3) => {
        const now = Date.now();
        return { updated: now, backups: [{ name: "NAS", max_age_hours: limit, snapshots: [{ time: now - age }] }] };
    };

    test("backup age is healthy below the limit and fails at the limit", async () => {
        assert.equal(await passes(backupHealthy("NAS"), state(3 * 3600000 - 60000)), true);
        assert.equal(await passes(backupHealthy("NAS"), state(3 * 3600000)), false);
    });
    test("off-site age uses its own 100-hour limit", async () => {
        const data = state(99 * 3600000, 100);
        data.backups[0].name = "WDMyCloud Abbaye";
        assert.equal(await passes(backupHealthy("WDMyCloud Abbaye"), data), true);
        data.backups[0].snapshots[0].time -= 3600000;
        assert.equal(await passes(backupHealthy("WDMyCloud Abbaye"), data), false);
    });
    test("missing snapshots and missing repositories do not pass", async () => {
        const data = state(0);
        data.backups[0].snapshots = [];
        assert.equal(await passes(backupHealthy("NAS"), data), false);
        data.backups = [];
        assert.equal(await passes(backupHealthy("NAS"), data), false);
    });
    test("stale homepage state and future-dated snapshots fail", async () => {
        const data = state(0);
        data.updated -= 60000;
        assert.equal(await passes(backupHealthy("NAS"), data), false);
        assert.equal(await passes(backupHealthy("NAS"), state(-3600000)), false);
    });
    test("duplicate repositories fail rather than selecting an arbitrary snapshot", async () => {
        const data = state(0);
        data.backups.push(data.backups[0]);
        assert.equal(await passes(backupHealthy("NAS"), data), false);
    });
    test("Authentik must return the identification stage", async () => {
        assert.equal(await passes(probes[0].jsonPath, { component: "ak-stage-identification" }), true);
        assert.equal(await passes(probes[0].jsonPath, { component: "ak-stage-error" }), false);
        assert.equal(await passes(probes[0].jsonPath, {}), false);
    });
    test("Prometheus errors, missing results and failing conditions fail", async () => {
        const expression = probes[1].jsonPath;
        assert.equal(await passes(expression, { status: "success", data: { result: [{ value: [0, "1"] }] } }), true);
        assert.equal(await passes(expression, { status: "success", data: { result: [{ value: [0, "0"] }] } }), false);
        assert.equal(await passes(expression, { status: "success", data: { result: [] } }), false);
        assert.equal(await passes(expression, { status: "error" }), false);
    });
    test("Discord templates render outage, recovery and test emojis without sending", async () => {
        const Provider = require("/app/server/notification-providers/notification-provider");
        const provider = new Provider();
        const template = discordEmojiSettings({}).discordMessageTemplate;
        const monitor = { name: "Example service", type: "http", url: "https://example.invalid" };
        const heartbeat = { time: "2026-11-27T14:00:00Z", msg: "Connection failed", ping: 0 };
        const down = await provider.renderTemplate(template, "outage", monitor, { ...heartbeat, status: 0 });
        const up = await provider.renderTemplate(template, "recovered", monitor, { ...heartbeat, status: 1 });
        const testMessage = await provider.renderTemplate(template, "Labelled test", null, null);
        assert.ok(down.startsWith("🚨 **DOWN**"));
        assert.ok(up.startsWith("✅ **UP**"));
        assert.ok(testMessage.startsWith("🧪 **TEST**"));
        assert.ok(down.includes(monitor.name) && down.includes(monitor.url));
        assert.ok(down.includes(heartbeat.time) && down.includes(heartbeat.msg) && down.includes("Ping: 0 ms"));
        assert.equal(testMessage.includes("testing.hostname"), false);
    });
    test("Discord settings preserve transport configuration and respect hidden URLs", async () => {
        const original = { discordWebhookUrl: "https://example.invalid/test", discordSuppressNotifications: true, disableUrl: true };
        const settings = discordEmojiSettings(original);
        assert.equal(settings.discordWebhookUrl, original.discordWebhookUrl);
        assert.equal(settings.discordSuppressNotifications, true);
        assert.equal(settings.applyExisting, false);
        assert.equal(settings.discordMessageTemplate.includes("hostnameOrURL"), false);
        assert.equal(original.discordMessageFormat, undefined);
    });
    test("Discord content stays within its 2000-character limit", async () => {
        const Provider = require("/app/server/notification-providers/notification-provider");
        const content = await new Provider().renderTemplate(
            discordEmojiSettings({}).discordMessageTemplate, "error",
            { name: "Example", type: "http", url: "https://example.invalid" },
            { status: 0, msg: "x".repeat(5000), time: "2026-11-27T14:00:00Z" },
        );
        assert.ok(content.startsWith("🚨 **DOWN**"));
        assert.ok(Array.from(content).length <= 2000);
    });
}
