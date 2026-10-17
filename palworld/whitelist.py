import base64
import json
import os
import time
import urllib.request

API = os.environ.get("PALWORLD_API", "http://palworld:8212/v1/api")
AUTH = "Basic " + base64.b64encode(f"admin:{os.environ['ADMIN_PASSWORD']}".encode()).decode()
INTERVAL = int(os.environ.get("CHECK_INTERVAL", "5"))
# Shared with the Discord bot: we write kicked unknown players to pending.json,
# the bot writes the approvals to decisions.json
DATA = os.environ.get("WHITELIST_DIR", "/data")
PENDING = f"{DATA}/pending.json"
DECISIONS = f"{DATA}/decisions.json"

# WHITELIST format: "<PlayerUID>:<Name>,..." - PlayerUID is the save file name in Players/
WHITELIST = {}
for entry in os.environ["WHITELIST"].split(","):
    uid, _, name = entry.strip().partition(":")
    WHITELIST[uid.replace("-", "").upper()] = name


def api(path, payload=None):
    req = urllib.request.Request(
        f"{API}/{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": AUTH, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read()
        return json.loads(body) if body else None


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save(path, data):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


pending = load(PENDING)
print(f"Whitelist: {', '.join(f'{n} ({u})' for u, n in WHITELIST.items())}", flush=True)
while True:
    try:
        approved = {uid for uid, d in load(DECISIONS).items() if d.get("status") == "approved"}
        for p in api("players")["players"]:
            uid = p.get("playerId", "").replace("-", "").upper()
            # Player still loading in: ID not assigned yet, check again next round
            if not uid or set(uid) == {"0"}:
                continue
            if uid not in WHITELIST and uid not in approved:
                print(f"Kicking {p.get('name')} ({uid}, {p.get('userId')})", flush=True)
                api("kick", {"userid": p["userId"], "message": "You are not whitelisted on this server."})
                if uid not in pending:
                    pending[uid] = {k: p.get(k) for k in ("name", "accountName", "userId")}
                    save(PENDING, pending)
    except Exception as e:
        # Server is down or still starting
        print(f"API error: {e}", flush=True)
        time.sleep(30)
    time.sleep(INTERVAL)
