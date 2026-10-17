import os
import time

import aiohttp
import discord
from discord.ext import tasks

TOKEN = os.environ["DISCORD_BOT_TOKEN"]
# Bot is shared with the Minecraft mod (Colo Carnies): only ever act in this server
GUILD_ID = int(os.environ["DISCORD_GUILD_ID"])
CHANNEL_ID = int(os.environ["DISCORD_CHANNEL_ID"])
# Optional: only members with this role can press the buttons
ROLE_ID = int(os.environ.get("DISCORD_ROLE_ID") or 0)
DOCKER = os.environ.get("DOCKER_URL", "http://palworld-docker-proxy:2375")
API = os.environ.get("PALWORLD_API", "http://palworld:8212/v1/api")
AUTH = {"Authorization": aiohttp.encode_basic_auth("admin", os.environ["ADMIN_PASSWORD"])}
CONTAINER = "palworld"
# Stop the server after this many minutes with nobody online (0 = never)
IDLE_MINUTES = int(os.environ.get("IDLE_MINUTES") or 10)


async def docker(method, path):
    async with aiohttp.ClientSession() as s:
        async with s.request(method, f"{DOCKER}{path}", timeout=aiohttp.ClientTimeout(total=60)) as r:
            # 304 = already started/stopped
            if r.status >= 400:
                raise RuntimeError(f"Docker API {r.status}: {await r.text()}")
            return await r.json(content_type=None)


async def palworld(method, path):
    async with aiohttp.ClientSession(headers=AUTH) as s:
        async with s.request(method, f"{API}/{path}", timeout=aiohttp.ClientTimeout(total=10)) as r:
            r.raise_for_status()
            return await r.json(content_type=None)


async def is_running():
    return (await docker("GET", f"/containers/{CONTAINER}/json"))["State"]["Running"]


async def shutdown():
    try:
        await palworld("POST", "save")
    except Exception:
        pass
    await docker("POST", f"/containers/{CONTAINER}/stop?t=30")


def status_text(running):
    return f"**Palworld server**: {'🟢 running' if running else '🔴 stopped'}"


class Panel(discord.ui.View):
    def __init__(self):
        # timeout=None + fixed custom_ids: buttons keep working after bot restarts
        super().__init__(timeout=None)

    async def interaction_check(self, interaction):
        if interaction.guild_id != GUILD_ID:
            return False
        if ROLE_ID and not any(r.id == ROLE_ID for r in getattr(interaction.user, "roles", [])):
            await interaction.response.send_message("You are not allowed to do that.", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="Start", style=discord.ButtonStyle.success, custom_id="palworld:start")
    async def start(self, interaction, _):
        await interaction.response.defer(ephemeral=True, thinking=True)
        await docker("POST", f"/containers/{CONTAINER}/start")
        print(f"Start requested by {interaction.user}", flush=True)
        await interaction.message.edit(content=status_text(True))
        await interaction.followup.send("Server starting, it can take a few minutes before you can join.", ephemeral=True)

    @discord.ui.button(label="Stop", style=discord.ButtonStyle.danger, custom_id="palworld:stop")
    async def stop(self, interaction, _):
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            players = (await palworld("GET", "players"))["players"]
        except Exception:
            # API not answering (server stopped or still loading): nobody can be playing
            players = []
        if players:
            names = ", ".join(p["name"] for p in players)
            await interaction.followup.send(f"Can't stop: still playing: {names}", ephemeral=True)
            return
        await shutdown()
        print(f"Stop requested by {interaction.user}", flush=True)
        await interaction.message.edit(content=status_text(False))
        await interaction.followup.send("Server stopped.", ephemeral=True)

    async def on_error(self, interaction, error, item):
        print(f"Error on {item.custom_id}: {error}", flush=True)
        await interaction.followup.send(f"Error: {error}", ephemeral=True)


class Bot(discord.Client):
    panel = None
    # monotonic time since the server was seen running with 0 players
    empty_since = None

    async def setup_hook(self):
        self.add_view(Panel())

    async def on_ready(self):
        if self.panel:
            return
        channel = await self.fetch_channel(CHANNEL_ID)
        if getattr(channel, "guild", None) is None or channel.guild.id != GUILD_ID:
            raise SystemExit(f"Channel {CHANNEL_ID} is not in guild {GUILD_ID}, refusing to post")
        async for msg in channel.history(limit=50):
            if msg.author == self.user and msg.components:
                self.panel = msg
                break
        content = status_text(await is_running())
        if self.panel:
            await self.panel.edit(content=content, view=Panel())
        else:
            self.panel = await channel.send(content, view=Panel())
        self.refresh.start()
        print(f"Ready as {self.user}", flush=True)

    # Keeps the status right if the server stops/starts outside of Discord,
    # and stops it when nobody has been online for IDLE_MINUTES
    @tasks.loop(seconds=60)
    async def refresh(self):
        try:
            running = await is_running()
            if running and IDLE_MINUTES:
                running = await self.check_idle()
            else:
                self.empty_since = None
            content = status_text(running)
            if self.panel.content != content:
                self.panel = await self.panel.edit(content=content)
        except Exception as e:
            print(f"Refresh failed: {e}", flush=True)

    async def check_idle(self):
        """Returns whether the server is still running."""
        try:
            players = (await palworld("GET", "players"))["players"]
        except Exception:
            # Still loading after a start: only count once the API answers
            return True
        if players:
            self.empty_since = None
            return True
        if self.empty_since is None:
            self.empty_since = time.monotonic()
            return True
        if time.monotonic() - self.empty_since < IDLE_MINUTES * 60:
            return True
        print(f"Nobody online for {IDLE_MINUTES} min, stopping", flush=True)
        self.empty_since = None
        await shutdown()
        return False


Bot(intents=discord.Intents.default()).run(TOKEN)
