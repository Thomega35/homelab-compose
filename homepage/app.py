"""thomega.fr homepage: service status, host metrics and game servers overview.

A background task refreshes everything every REFRESH_SECONDS; the page polls /api/state.
"""
import asyncio
import json
import os
import re
import socket
import struct
import time
from pathlib import Path

import aiohttp
import yaml
from aiohttp import web
from aiohttp.abc import AbstractResolver
from aiohttp.resolver import DefaultResolver

CONFIG = yaml.safe_load(Path(os.environ.get("CONFIG_FILE", "/app/config.yml")).read_text())
DOMAIN = os.environ.get("DOMAIN", "thomega.fr")
TRAEFIK = os.environ.get("TRAEFIK_HOST", "traefik")
PROMETHEUS = os.environ.get("PROMETHEUS_URL", "http://prometheus:9090")
LOKI = os.environ.get("LOKI_URL", "http://loki:3100")
DOCKER = os.environ.get("DOCKER_URL", "http://homepage-docker-proxy:2375")
PALWORLD_API = os.environ.get("PALWORLD_API", "http://palworld:8212/v1/api")
PALWORLD_AUTH = {"Authorization": aiohttp.encode_basic_auth("admin", os.environ.get("PALWORLD_ADMIN_PASSWORD", ""))}
REFRESH = int(os.environ.get("REFRESH_SECONDS") or 15)
STATIC = Path(__file__).with_name("static")
NODE = 'job="node-exporter"'

ANSI = re.compile(r"\x1b\[[0-9;]*m")
# "[18:02:44] [Server thread/INFO]: " / "[2026-10-17 18:02:44] [LOG] "
LOG_PREFIX = re.compile(r"^(\[[^\]]*\]\s*)+:?\s*")
HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https://cdn.jsdelivr.net; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
}

state = {"updated": None, "system": None, "games": {}, "services": []}


class TraefikResolver(AbstractResolver):
    """Sends *.DOMAIN to Traefik: probes take the same path as a visitor,
    without depending on the LAN DNS or hairpin NAT."""

    def __init__(self):
        self.default = DefaultResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        if host != DOMAIN and not host.endswith("." + DOMAIN):
            return await self.default.resolve(host, port, family)
        # Keep the requested hostname: it's used for SNI and the certificate check
        return [{**r, "hostname": host} for r in await self.default.resolve(TRAEFIK, port, family)]

    async def close(self):
        await self.default.close()


async def safe(name, coro):
    try:
        return await coro
    except Exception as e:
        print(f"{name}: {e!r}", flush=True)
        return None


async def get_json(session, url, **kwargs):
    async with session.get(url, **kwargs) as r:
        r.raise_for_status()
        return await r.json(content_type=None)


# --- Docker ------------------------------------------------------------------

async def containers(session):
    data = await get_json(session, f"{DOCKER}/containers/json", params={"all": "1"})
    return {
        name.lstrip("/"): {"state": c["State"], "status": c["Status"], "healthy": "(unhealthy)" not in c["Status"]}
        for c in data
        for name in c["Names"]
    }


def container_state(ctrs, name):
    if ctrs is None:
        return None
    return ctrs.get(name, {}).get("state", "missing")


# --- Services ----------------------------------------------------------------

async def check_service(session, svc, ctrs):
    names = svc.get("containers", []) if ctrs is not None else []
    states = [ctrs.get(n) for n in names]
    running = [s for s in states if s and s["state"] == "running"]
    result = {k: svc.get(k) for k in ("name", "url", "icon", "description")}
    result["power"] = bool(svc.get("power"))
    result["containers"] = [{"name": n, "status": s["status"] if s else "missing"} for n, s in zip(names, states)]

    # Turned off on purpose from the power button: not an outage, and its URL can't answer
    if svc.get("power") and states and not running:
        result["status"] = "stopped"
        return result

    http_ok = True
    if svc.get("url"):
        start = time.monotonic()
        try:
            async with session.get(svc["url"], allow_redirects=False) as r:
                result["http"] = r.status
                # Redirects (Authentik login) and auth challenges mean the app answers
                http_ok = r.status < 400 or r.status in (401, 403)
            result["latency"] = round((time.monotonic() - start) * 1000)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            result["http"] = type(e).__name__
            http_ok = False

    if not http_ok or (states and not running):
        # Just powered on from the homepage: the app is still booting
        booting = time.monotonic() - powered_on.get(svc["name"], -STARTING_GRACE) < STARTING_GRACE
        result["status"] = "starting" if booting and running else "down"
    elif len(running) < len(states) or not all(s["healthy"] for s in running):
        result["status"] = "degraded"
    else:
        result["status"] = "up"
    return result


async def services(session, ctrs):
    groups = CONFIG.get("groups", [])
    checks = [[check_service(session, svc, ctrs) for svc in g["services"]] for g in groups]
    results = await asyncio.gather(*(asyncio.gather(*c) for c in checks))
    return [{"name": g["name"], "services": r} for g, r in zip(groups, results)]


# --- Host metrics (node-exporter via Prometheus) -----------------------------

async def prom(session, query):
    return (await get_json(session, f"{PROMETHEUS}/api/v1/query", params={"query": query}))["data"]["result"]


async def system(session):
    queries = {
        "cpu": f'100 * (1 - avg(rate(node_cpu_seconds_total{{{NODE},mode="idle"}}[2m])))',
        "cores": f'count(node_cpu_seconds_total{{{NODE},mode="idle"}})',
        "load": f"node_load1{{{NODE}}}",
        "mem_total": f"node_memory_MemTotal_bytes{{{NODE}}}",
        "mem_avail": f"node_memory_MemAvailable_bytes{{{NODE}}}",
        "mem_free": f"node_memory_MemFree_bytes{{{NODE}}}",
        "swap_total": f"node_memory_SwapTotal_bytes{{{NODE}}}",
        "swap_free": f"node_memory_SwapFree_bytes{{{NODE}}}",
        # pages/s * 4 KiB
        "swap_in": f"4096 * rate(node_vmstat_pswpin{{{NODE}}}[5m])",
        # % of time at least one task waited for memory (PSI "some")
        "mem_pressure": f"100 * rate(node_pressure_memory_waiting_seconds_total{{{NODE}}}[5m])",
        "uptime": f"time() - node_boot_time_seconds{{{NODE}}}",
        "fs_size": f"node_filesystem_size_bytes{{{NODE}}}",
        "fs_avail": f"node_filesystem_avail_bytes{{{NODE}}}",
    }
    r = dict(zip(queries, await asyncio.gather(*(prom(session, q) for q in queries.values()))))
    size = {m["metric"]["mountpoint"]: float(m["value"][1]) for m in r.pop("fs_size")}
    avail = {m["metric"]["mountpoint"]: float(m["value"][1]) for m in r.pop("fs_avail")}
    v = {k: float(x[0]["value"][1]) if x else None for k, x in r.items()}
    storage = []
    for disk in CONFIG.get("storage", []):
        mp = disk["mountpoint"]
        if mp in size:
            storage.append({**disk, "size": size[mp], "used": size[mp] - avail[mp]})
        else:
            storage.append({**disk, "size": None, "used": None})
    # Used = not reclaimable (MemTotal - MemAvailable); cache = reclaimable part of buffers/page cache
    mem_used = v["mem_total"] - v["mem_avail"] if v["mem_total"] is not None else None
    mem_cache = v["mem_avail"] - v["mem_free"] if v["mem_avail"] is not None else None
    swap_used = v["swap_total"] - v["swap_free"] if v["swap_total"] else None
    return {
        "name": CONFIG.get("server_name"),
        "cpu": v["cpu"],
        "cores": v["cores"],
        "load": v["load"],
        "mem_used": mem_used,
        "mem_cache": mem_cache,
        "mem_total": v["mem_total"],
        "mem_pressure": v["mem_pressure"],
        "swap_used": swap_used,
        "swap_total": v["swap_total"],
        "swap_in": v["swap_in"],
        "uptime": v["uptime"],
        "storage": storage,
    }


# --- Logs (Loki) -------------------------------------------------------------

def format_line(line):
    line = ANSI.sub("", line).strip()
    # Palworld image: 'Sending Discord json: {"embeds":[{"title":..,"description":..,"color":..}]}'
    _, sep, payload = line.partition("Sending Discord json:")
    if sep:
        try:
            data = json.loads(payload)
            embed = (data.get("embeds") or [{}])[0]
            text = data.get("content") or " - ".join(filter(None, (embed.get("title"), embed.get("description"))))
            return {"text": text, "color": embed.get("color")}
        except (ValueError, AttributeError):
            pass
    return {"text": LOG_PREFIX.sub("", line)}


async def logs(session, cfg):
    limit = cfg.get("limit", 10)
    params = {
        "query": cfg["query"],
        "limit": limit,
        "direction": "backward",
        "start": str(time.time_ns() - cfg.get("days", 7) * 86400 * 10**9),
    }
    streams = (await get_json(session, f"{LOKI}/loki/api/v1/query_range", params=params))["data"]["result"]
    entries = sorted(((int(ts), line) for s in streams for ts, line in s["values"]), reverse=True)[:limit]
    return [{"time": ts // 10**6, **format_line(line)} for ts, line in entries]


# --- Minecraft ---------------------------------------------------------------

def varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


async def read_varint(reader):
    value = 0
    for shift in range(0, 35, 7):
        byte = (await reader.readexactly(1))[0]
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value
    raise ValueError("VarInt too long")


async def minecraft_ping(host, port):
    """Server List Ping: the status JSON the game shows in its server list."""
    reader, writer = await asyncio.open_connection(host, port)
    try:
        address = host.encode()
        handshake = b"\x00" + varint(767) + varint(len(address)) + address + struct.pack(">H", port) + varint(1)
        writer.write(varint(len(handshake)) + handshake + b"\x01\x00")
        await writer.drain()
        await read_varint(reader)  # packet length
        await read_varint(reader)  # packet id
        length = await read_varint(reader)
        return json.loads(await reader.readexactly(length))
    finally:
        writer.close()


async def minecraft(session, ctrs):
    cfg = CONFIG["minecraft"]
    game = {k: cfg.get(k) for k in ("name", "address", "url", "icon")}
    running = container_state(ctrs, cfg["container"])
    game["status"] = "offline"
    if running in (None, "running"):
        try:
            status = await asyncio.wait_for(minecraft_ping(cfg["host"], cfg.get("port", 25565)), 5)
            players = status.get("players", {})
            game.update(
                status="online",
                version=status.get("version", {}).get("name"),
                online=players.get("online", 0),
                max=players.get("max"),
                # The server only sends a sample (12 players max)
                players=sorted(({"name": p["name"]} for p in players.get("sample", [])), key=lambda p: p["name"].lower()),
            )
        except (OSError, EOFError, ValueError, asyncio.TimeoutError):
            if running == "running":
                game["status"] = "starting"
    game["logs"] = await safe("minecraft logs", logs(session, cfg["logs"])) or []
    return game


# --- Palworld ----------------------------------------------------------------

async def palworld(session, ctrs):
    cfg = CONFIG["palworld"]
    game = {k: cfg.get(k) for k in ("name", "address", "url", "icon", "hint")}
    game["power"] = bool(cfg.get("power"))
    running = container_state(ctrs, cfg["container"])
    game["status"] = "offline"
    if running in (None, "running"):
        try:
            info, metrics, players = await asyncio.gather(
                *(get_json(session, f"{PALWORLD_API}/{p}", headers=PALWORLD_AUTH) for p in ("info", "metrics", "players"))
            )
            game.update(
                status="online",
                version=info.get("version"),
                server_name=info.get("servername"),
                online=len(players["players"]),
                max=metrics.get("maxplayernum"),
                days=metrics.get("days"),
                fps=metrics.get("serverfps"),
                players=sorted(
                    ({"name": p["name"], "level": p.get("level")} for p in players["players"]),
                    key=lambda p: p["name"].lower(),
                ),
            )
        except (aiohttp.ClientError, asyncio.TimeoutError, KeyError):
            # REST API only answers once the world is loaded
            if running == "running":
                game["status"] = "starting"
    game["logs"] = await safe("palworld logs", logs(session, cfg["logs"])) or []
    return game


# --- Refresh loop & web server -----------------------------------------------

async def refresh(session):
    ctrs = await safe("docker", containers(session))
    svc, sys_, mc, pal = await asyncio.gather(
        safe("services", services(session, ctrs)),
        safe("system", system(session)),
        safe("minecraft", minecraft(session, ctrs)),
        safe("palworld", palworld(session, ctrs)),
    )
    state.update(
        updated=int(time.time() * 1000),
        services=svc or [],
        system=sys_,
        games={"minecraft": mc, "palworld": pal},
    )


async def refresh_loop(session):
    while True:
        await refresh(session)
        await asyncio.sleep(REFRESH)


async def background(app):
    global http
    connector = aiohttp.TCPConnector(resolver=TraefikResolver())
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=8)) as http:
        task = asyncio.create_task(refresh_loop(http))
        yield
        task.cancel()


# --- Power buttons -----------------------------------------------------------

POWER_GROUPS = set(CONFIG.get("power_groups", ["admin"]))
STARTING_GRACE = 300  # seconds
power_lock = asyncio.Lock()
# service name -> monotonic time of the last start from the power button
powered_on = {}
http = None


async def can_power(request):
    """X-authentik-* headers are set by Traefik's forward auth (client values are overwritten),
    so only trust them on requests coming from Traefik itself."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(TRAEFIK, None)
    except OSError:
        return False
    if request.remote not in {i[4][0] for i in infos}:
        return False
    groups = set(filter(None, request.headers.get("X-authentik-groups", "").split("|")))
    return bool(groups & POWER_GROUPS)


def power_target(name):
    """Service tiles with `power: true`, and the Palworld card."""
    for g in CONFIG.get("groups", []):
        for s in g["services"]:
            if s.get("power") and s["name"] == name:
                return s
    pal = CONFIG.get("palworld", {})
    if pal.get("power") and pal.get("name") == name:
        return {"name": name, "containers": [pal["container"]], "palworld": True}
    return None


async def palworld_before_stop():
    """Same rules as the Discord bot: never stop with people online, save the world first."""
    try:
        async with http.get(f"{PALWORLD_API}/players", headers=PALWORLD_AUTH) as r:
            r.raise_for_status()
            players = (await r.json(content_type=None))["players"]
    except (aiohttp.ClientError, asyncio.TimeoutError, KeyError):
        # API not answering (stopped or still loading): nobody can be playing
        return
    if players:
        names = ", ".join(p["name"] for p in players)
        raise web.HTTPConflict(text=f"Still playing: {names}")
    try:
        async with http.post(f"{PALWORLD_API}/save", headers=PALWORLD_AUTH, timeout=aiohttp.ClientTimeout(total=60)) as r:
            r.raise_for_status()
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        print(f"Palworld save before stop failed: {e!r}", flush=True)


async def api_power(request):
    # Custom header: cross-site pages can't send it without a CORS preflight, which is never allowed
    if request.headers.get("X-Homepage") != "1" or not await can_power(request):
        raise web.HTTPForbidden(text="Not allowed")
    try:
        body = await request.json()
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid JSON")
    action = body.get("action")
    svc = power_target(body.get("service"))
    if not svc or action not in ("start", "stop"):
        raise web.HTTPBadRequest(text="Unknown service or action")

    # Containers are listed in start order (dependencies first): stop in reverse
    names = svc["containers"] if action == "start" else svc["containers"][::-1]
    async with power_lock:
        print(f"{action} {svc['name']} requested by {request.headers.get('X-authentik-username')}", flush=True)
        if action == "stop" and svc.get("palworld"):
            await palworld_before_stop()
        for name in names:
            async with http.post(
                f"{DOCKER}/containers/{name}/{action}",
                params={"t": "30"} if action == "stop" else None,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as r:
                # 304 = already started/stopped
                if r.status >= 400:
                    raise web.HTTPBadGateway(text=f"{name}: Docker API {r.status}")
        if action == "start":
            powered_on[svc["name"]] = time.monotonic()
        else:
            powered_on.pop(svc["name"], None)
        await refresh(http)
    return web.json_response({"ok": True})


@web.middleware
async def security_headers(request, handler):
    response = await handler(request)
    response.headers.update(HEADERS)
    return response


async def api_state(request):
    return web.json_response({**state, "can_power": await can_power(request)}, headers={"Cache-Control": "no-store"})


async def index(request):
    return web.FileResponse(STATIC / "index.html")


app = web.Application(middlewares=[security_headers])
app.cleanup_ctx.append(background)
app.router.add_get("/", index)
app.router.add_get("/api/state", api_state)
app.router.add_post("/api/power", api_power)
app.router.add_static("/static", STATIC)

if __name__ == "__main__":
    web.run_app(app, port=8080, access_log=None)
