"use strict";

const REFRESH_MS = 10000;
const ICON_CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/";
const $ = (id) => document.getElementById(id);

// Drops null/undefined/false so conditional children (`x && h(...)`) never render as text
const clean = (children) => children.flat(Infinity).filter((c) => c != null && c !== false);

function fill(el, ...children) {
  el.replaceChildren(...clean(children));
}

// Builds DOM nodes; strings become text nodes (never parsed as HTML)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...clean(children));
  return el;
}

function bytes(n) {
  if (n == null) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

function duration(s) {
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`;
}

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

const level = (p) => (p >= 90 ? "crit" : p >= 75 ? "warn" : "ok");

// `extra`: optional second segment (e.g. reclaimable cache), drawn lighter after the main one
function bar(percent, extra) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const e = Math.max(0, Math.min(100 - p, extra ?? 0));
  return h("div", { class: `bar ${level(p)}` },
    h("div", { style: { width: `${p}%` } }),
    e > 0 && h("div", { class: "extra", style: { width: `${e}%` } }));
}

// Used space split into known parts (`parts`: pct + color index), the rest in the usual ok/warn/crit color
function stackedBar(percent, parts) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  let rest = p;
  const segments = parts.map((x) => {
    const w = Math.max(0, Math.min(rest, x.pct ?? 0));
    rest -= w;
    return w > 0 && h("div", { class: `part c${x.color}`, style: { width: `${w}%` } });
  });
  return h("div", { class: `bar ${level(p)}` }, segments, h("div", { style: { width: `${rest}%` } }));
}

function icon(name, label) {
  const fallback = h("span", { class: "icon letter" }, (label || "?")[0]);
  if (!name) return fallback;
  const src = /^(https?:)?\//.test(name) ? name : `${ICON_CDN}${name}.svg`;
  return h("img", { class: "icon", src, alt: "", loading: "lazy", onerror: (e) => e.target.replaceWith(fallback) });
}

function metric(label, value, sub, percent, extra) {
  return h("div", { class: "metric" },
    h("div", { class: "metric-head" }, h("span", { class: "muted" }, label), h("strong", {}, value)),
    percent != null && bar(percent, extra),
    sub && h("div", { class: "muted small" }, sub));
}

// --- Server -------------------------------------------------------------------

function renderHost(sys) {
  if (!sys) return fill($("host"), h("h2", {}, "Server"), h("p", { class: "muted" }, "Metrics unavailable"));
  const memPct = sys.mem_total ? (100 * sys.mem_used) / sys.mem_total : null;
  const cachePct = sys.mem_total && sys.mem_cache != null ? (100 * sys.mem_cache) / sys.mem_total : null;
  const swapPct = sys.swap_total ? (100 * sys.swap_used) / sys.swap_total : null;
  // PSI: share of time tasks waited for memory; a few % means the server really lacks RAM
  const pressure = sys.mem_pressure != null
    ? `pressure ${sys.mem_pressure < 0.1 ? "< 0.1" : sys.mem_pressure.toFixed(1)} %` : null;
  const swapIn = sys.swap_in != null ? `swap-in ${bytes(sys.swap_in)}/s` : null;
  fill($("host"),
    h("h2", {}, sys.name || "Server", sys.uptime != null && h("span", { class: "muted small" }, ` up ${duration(sys.uptime)}`)),
    h("div", { class: "metrics" },
      metric("CPU", sys.cpu != null ? `${sys.cpu.toFixed(0)} %` : "?",
        sys.load != null ? `load ${sys.load.toFixed(2)} / ${sys.cores} cores` : null, sys.cpu),
      metric("RAM", memPct != null ? `${memPct.toFixed(0)} %` : "?",
        [`${bytes(sys.mem_used)} used + ${bytes(sys.mem_cache)} cache / ${bytes(sys.mem_total)}`, pressure].filter(Boolean).join(" - "),
        memPct, cachePct),
      sys.swap_total ? metric("Swap", `${swapPct.toFixed(0)} %`,
        [`${bytes(sys.swap_used)} / ${bytes(sys.swap_total)}`, swapIn].filter(Boolean).join(" - "), swapPct)
        : metric("Swap", "none")));
}

function renderStorage(sys) {
  const disks = sys?.storage ?? [];
  // Same color for a label on every disk (e.g. Backup on both NAS)
  const colors = new Map();
  for (const d of disks) for (const u of d.usage ?? []) if (!colors.has(u.name)) colors.set(u.name, colors.size % 4);
  fill($("storage"),
    h("h2", {}, "Storage"),
    h("div", { class: "metrics" },
      disks.map((d) => {
        if (d.size == null) return metric(d.name, "unavailable", `${d.mountpoint} not mounted`);
        const pct = (100 * d.used) / d.size;
        const parts = (d.usage ?? []).map((u) => ({ ...u, pct: u.bytes != null ? (100 * u.bytes) / d.size : null, color: colors.get(u.name) }));
        return h("div", { class: "metric" },
          h("div", { class: "metric-head" }, h("span", { class: "muted" }, d.name), h("strong", {}, `${pct.toFixed(0)} %`)),
          stackedBar(pct, parts),
          h("div", { class: "muted small" }, `${bytes(d.used)} / ${bytes(d.size)} - ${bytes(d.size - d.used)} free`),
          parts.length > 0 && h("div", { class: "legend muted small" },
            parts.map((p) => h("span", {},
              h("i", { class: `swatch c${p.color}` }),
              p.bytes != null ? `${p.name} ${bytes(p.bytes)} (${p.pct.toFixed(0)} %)` : `${p.name} ?`))));
      })));
}

// --- Backups ------------------------------------------------------------------

const dateTime = (ms) => new Date(ms).toLocaleString([], { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function renderBackups(repos) {
  fill($("backups"),
    h("h2", {}, "Backups"),
    h("div", { class: "backups" }, repos.map((r) => {
      const snaps = r.snapshots ?? [];
      const latest = snaps[0];
      const late = latest && r.max_age_hours != null && Date.now() - latest.time > r.max_age_hours * 3600e3;
      return h("div", {},
        h("div", { class: "metric-head" },
          h("span", {}, h("strong", {}, r.name), h("span", { class: "muted small" }, ` ${snaps.length} snapshots`)),
          latest
            ? h("span", { class: `pill ${late ? "starting" : "online"}`, title: dateTime(latest.time) }, `Latest ${ago(latest.time)}`)
            : h("span", { class: "pill offline" }, "No data")),
        snaps.length > 0 && h("ul", { class: "logs snapshots" }, snaps.map((s) => h("li", {},
          h("time", { title: new Date(s.time).toLocaleString() }, dateTime(s.time)),
          h("code", { class: "muted" }, s.id),
          h("span", {}, bytes(s.size))))));
    })));
}

// --- Games --------------------------------------------------------------------

const GAME_STATUS = { online: "Online", starting: "Starting", offline: "Offline" };

function copyButton(text) {
  return h("button", {
    class: "copy",
    title: "Copy address",
    onclick: async (e) => {
      await navigator.clipboard.writeText(text);
      e.target.textContent = "Copied";
      setTimeout(() => (e.target.textContent = "Copy"), 1500);
    },
  }, "Copy");
}

function renderGame(id, game, canPower) {
  const card = $(id);
  if (!game) return fill(card, h("h2", {}, id), h("p", { class: "muted" }, "Status unavailable"));
  const online = game.status === "online";
  const stats = online ? [
    ["Players", `${game.online} / ${game.max ?? "?"}`],
    game.version && ["Version", game.version],
    game.days != null && ["Day", game.days],
    game.fps != null && ["Server FPS", game.fps],
  ].filter(Boolean) : [];
  const players = game.players ?? [];
  const hidden = online ? game.online - players.length : 0;

  fill(card,
    h("div", { class: "game-head" },
      icon(game.icon, game.name),
      h("h2", {}, game.name),
      h("span", { class: `pill ${game.status}` }, GAME_STATUS[game.status] ?? game.status),
      game.power && canPower && powerButton(game.name, game.status !== "offline")),
    h("div", { class: "address" },
      h("code", {}, game.address), copyButton(game.address),
      game.url && h("a", { href: game.url, target: "_blank", rel: "noopener noreferrer" }, "Open map")),
    game.server_name && h("div", { class: "muted small" }, game.server_name),
    !online && game.hint && h("div", { class: "muted small" }, game.hint),
    stats.length > 0 && h("dl", { class: "stats" }, stats.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, String(v))))),
    online && h("div", { class: "players" },
      players.length || hidden ? [
        players.map((p) => h("span", { class: "chip" }, p.name, p.level != null && h("small", {}, ` Lv ${p.level}`))),
        hidden > 0 && h("span", { class: "chip muted" }, `+${hidden} more`),
      ] : h("span", { class: "muted small" }, "Nobody online")),
    h("h3", {}, "Recent events"),
    game.logs?.length
      ? h("ul", { class: "logs" }, game.logs.map((l) => h("li", {},
          h("time", { title: new Date(l.time).toLocaleString() }, ago(l.time)),
          h("span", { class: "dot", style: l.color != null ? { background: `#${l.color.toString(16).padStart(6, "0")}` } : {} }),
          h("span", {}, l.text))))
      : h("p", { class: "muted small" }, "No recent events"));
}

// --- Services -----------------------------------------------------------------

function serviceTooltip(s) {
  const lines = [];
  if (s.http != null) lines.push(`HTTP ${s.http}${s.latency != null ? ` in ${s.latency} ms` : ""}`);
  for (const c of s.containers ?? []) lines.push(`${c.name}: ${c.status}`);
  return lines.join("\n");
}

// Services with a start/stop request in flight (survives the periodic re-render)
const pending = new Set();

function powerIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0");
  svg.append(path);
  return svg;
}

function powerButton(target, on) {
  const label = `${on ? "Stop" : "Start"} ${target}`;
  return h("button", {
    class: `power ${on ? "on" : "off"} ${pending.has(target) ? "busy" : ""}`,
    title: pending.has(target) ? `${target}: in progress...` : label,
    "aria-label": label,
    disabled: pending.has(target),
    onclick: async () => {
      if (on && !confirm(`${label}?`)) return;
      pending.add(target);
      await update();
      try {
        const r = await fetch("/api/power", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Homepage": "1" },
          body: JSON.stringify({ service: target, action: on ? "stop" : "start" }),
        });
        if (!r.ok) throw new Error((await r.text()) || r.status);
      } catch (err) {
        alert(`${label} failed: ${err.message}`);
      } finally {
        pending.delete(target);
        await update();
      }
    },
  }, powerIcon());
}

function renderServices(groups, canPower) {
  fill($("services"), groups.map((g) => h("section", { class: "group" },
    h("h2", {}, g.name),
    h("div", { class: "tiles" }, g.services.map((s) => {
      const host = s.url ? new URL(s.url).host : null;
      const name = h("strong", {}, s.name);
      return h("div", { class: `tile ${s.status} ${s.url ? "link" : ""}`, title: serviceTooltip(s) },
        icon(s.icon, s.name),
        h("div", { class: "tile-text" },
          // Stretched over the whole tile (CSS), so the tile stays clickable around the power button
          s.url ? h("a", { class: "stretched", href: s.url, target: "_blank", rel: "noopener noreferrer" }, name) : name,
          h("span", { class: "muted small" }, s.status === "stopped" ? "Stopped" : s.status === "starting" ? "Starting..." : s.description || host || "")),
        h("div", { class: "tile-status" },
          h("span", { class: "dot" }),
          s.latency != null && h("span", { class: "muted small" }, `${s.latency} ms`)),
        s.power && canPower && powerButton(s.name, s.status !== "stopped"));
    })))));

  const all = groups.flatMap((g) => g.services);
  const stopped = all.filter((s) => s.status === "stopped").length;
  const up = all.filter((s) => s.status === "up").length;
  const down = all.filter((s) => s.status === "down").length;
  const total = all.length - stopped;
  fill($("summary"),
    h("span", { class: `pill ${down ? "offline" : up === total ? "online" : "starting"}` }, `${up} / ${total} services up`),
    stopped > 0 && h("span", { class: "muted small" }, ` ${stopped} stopped`));
}

// --- Polling ------------------------------------------------------------------

async function update() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const s = await r.json();
    if (!s.updated) {
      $("updated").textContent = "Collecting data...";
      return;
    }
    renderHost(s.system);
    renderStorage(s.system);
    renderBackups(s.backups ?? []);
    renderGame("minecraft", s.games.minecraft, s.can_power);
    renderGame("palworld", s.games.palworld, s.can_power);
    renderServices(s.services, s.can_power);
    $("updated").textContent = `Updated ${new Date(s.updated).toLocaleTimeString()}`;
  } catch {
    // Authentik session expired (redirect) or server unreachable
    $("updated").textContent = "Connection lost - reload the page";
  }
}

update();
setInterval(update, REFRESH_MS);
