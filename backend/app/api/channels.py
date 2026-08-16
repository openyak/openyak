"""Channels API — manage in-process messaging platform channels.

Replaces the old OpenClaw-based system with nanobot's native channel
architecture running directly inside OpenYak (no external Node.js process).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import queue as _queue
from pathlib import Path
from typing import Any

from app.utils.atomic_write import atomic_write_text, file_lock
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ChannelSystemStatus(BaseModel):
    """Status of the in-process channel system."""
    running: bool
    channels: dict[str, Any]


class ChannelAddRequest(BaseModel):
    channel: str  # telegram, discord, slack, whatsapp, feishu, weixin, wecom, dingtalk, qq, email, matrix, mochat, websocket
    # Common fields
    allow_from: list[str] | None = None  # ["*"] for allow all
    # Token-based fields (varies by channel)
    token: str | None = None       # discord, telegram
    bot_token: str | None = None   # slack (xoxb-...)
    app_token: str | None = None   # slack (xapp-...)
    app_id: str | None = None      # feishu
    app_secret: str | None = None  # feishu
    # WeChat fields
    api_url: str | None = None     # weixin HTTP API URL
    # WhatsApp fields
    bridge_url: str | None = None  # whatsapp bridge WebSocket URL
    # General
    streaming: bool = False
    extra: dict[str, Any] | None = None  # Pass-through for any channel-specific config


class ChannelRemoveRequest(BaseModel):
    channel: str


class ChannelLoginRequest(BaseModel):
    channel: str = "whatsapp"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_channel_manager(request: Request):
    """Get the ChannelManager from app state."""
    return getattr(request.app.state, "channel_manager", None)


def _get_channels_config_path() -> Path:
    return Path("data/channels.json")


def _load_config_dict() -> dict:
    """Load raw channels.json config."""
    path = _get_channels_config_path()
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"channels": {}}


def _save_config_dict(data: dict) -> None:
    """Save raw channels.json config.

    This file holds the bot token for every connected channel, so it is written
    atomically and owner-only: a partial write disconnects all of them at once,
    and two concurrent /configure calls must not lose one another's channel.
    """
    path = _get_channels_config_path()
    with file_lock(path):
        atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Channel System Status
# ---------------------------------------------------------------------------

@router.get("/channels/status")
async def channels_status(request: Request) -> ChannelSystemStatus:
    """Get status of the in-process channel system."""
    mgr = _get_channel_manager(request)
    if mgr is None:
        return ChannelSystemStatus(running=False, channels={})

    return ChannelSystemStatus(
        running=bool(mgr.enabled_channels),
        channels=mgr.get_status(),
    )


# Backward-compat: old frontend polls /channels/openclaw/status
@router.get("/channels/openclaw/status")
async def openclaw_status_compat(request: Request) -> dict:
    """Backward-compatible status endpoint.

    Reports the new channel system as 'installed' and 'running'
    so the old frontend can work during the transition.
    """
    mgr = _get_channel_manager(request)
    running = mgr is not None and bool(mgr.enabled_channels)
    return {
        "installed": True,
        "running": running,
        "port": None,
        "ws_url": None,
    }


# Backward-compat stubs so old frontend doesn't error
@router.post("/channels/openclaw/setup")
async def openclaw_setup_compat(request: Request) -> dict:
    return {"status": "ready", "message": "Channel system is built-in (no setup needed)"}


@router.post("/channels/openclaw/start")
async def openclaw_start_compat(request: Request) -> dict:
    return {"status": "running", "message": "Channel system is always running"}


@router.post("/channels/openclaw/stop")
async def openclaw_stop_compat(request: Request) -> dict:
    return {"status": "stopped"}


@router.delete("/channels/openclaw/uninstall")
async def openclaw_uninstall_compat(request: Request) -> dict:
    return {"status": "not_applicable", "message": "Channel system is built-in"}


# ---------------------------------------------------------------------------
# Channel CRUD
# ---------------------------------------------------------------------------

@router.get("/channels")
async def list_channels(request: Request) -> dict:
    """List all configured channels and their status."""
    mgr = _get_channel_manager(request)
    running_channels = mgr.get_status() if mgr else {}

    # Also include configured-but-not-running channels from config
    config = _load_config_dict()
    all_channels: dict[str, Any] = {}

    for name, ch_config in config.get("channels", {}).items():
        enabled = ch_config.get("enabled", False)
        is_running = name in running_channels and running_channels[name].get("running", False)
        all_channels[name] = {
            "id": name,
            "name": name.capitalize(),
            "status": "running" if is_running else ("configured" if enabled else "disabled"),
            "type": name,
        }

    return {
        "channels": all_channels,
        "gateway_running": bool(running_channels),
    }


@router.post("/channels/add")
async def add_channel(request: Request, body: ChannelAddRequest) -> dict:
    """Add and enable a messaging channel.

    Saves config and starts the channel immediately if possible.
    """
    config = _load_config_dict()
    channels = config.setdefault("channels", {})

    # Build channel config
    ch_config: dict[str, Any] = {
        "enabled": True,
        "allow_from": body.allow_from or ["*"],
    }

    if body.channel == "telegram":
        if not body.token:
            raise HTTPException(400, "Telegram requires a bot token")
        ch_config["token"] = body.token

    elif body.channel == "discord":
        if not body.token:
            raise HTTPException(400, "Discord requires a bot token")
        ch_config["token"] = body.token

    elif body.channel == "slack":
        if not body.bot_token or not body.app_token:
            raise HTTPException(400, "Slack requires both bot_token and app_token")
        ch_config["bot_token"] = body.bot_token
        ch_config["app_token"] = body.app_token

    elif body.channel == "feishu":
        if not body.app_id or not body.app_secret:
            raise HTTPException(400, "Feishu requires app_id and app_secret")
        ch_config["app_id"] = body.app_id
        ch_config["app_secret"] = body.app_secret

    elif body.channel == "whatsapp":
        ch_config["bridge_url"] = body.bridge_url or "ws://localhost:3001"

    elif body.channel == "weixin":
        ch_config["api_url"] = body.api_url or "http://localhost:9503"

    elif body.channel in ("wecom", "dingtalk", "qq", "email", "matrix", "mochat", "websocket"):
        # Accept generic extra config
        if body.extra:
            ch_config.update(body.extra)
    else:
        raise HTTPException(400, f"Unknown channel: {body.channel}")

    if body.streaming:
        ch_config["streaming"] = True

    # Merge with existing config (don't overwrite fields not provided)
    existing = channels.get(body.channel, {})
    existing.update(ch_config)
    channels[body.channel] = existing

    _save_config_dict(config)

    # Try to start the channel immediately
    mgr = _get_channel_manager(request)
    if mgr:
        try:
            from app.channels.registry import load_channel_class
            cls = load_channel_class(body.channel)
            channel_instance = cls(existing, mgr.bus)
            mgr.add_channel(body.channel, channel_instance)

            import asyncio
            asyncio.create_task(channel_instance.start())

            logger.info("Channel %s added and started", body.channel)
        except Exception as e:
            logger.warning("Channel %s configured but failed to start: %s", body.channel, e)
            return {"ok": True, "message": f"{body.channel} configured (will start on restart): {e}"}

    return {"ok": True, "message": f"{body.channel} channel added and started"}


@router.post("/channels/login")
async def login_channel(request: Request, body: ChannelLoginRequest):
    """Start interactive login for a channel (e.g. WhatsApp QR).

    Returns SSE stream with QR data and progress updates.
    The frontend displays the QR code and waits for scan completion.
    """
    mgr = _get_channel_manager(request)
    if mgr is None:
        raise HTTPException(503, "Channel manager not initialized")

    # For WhatsApp: run bridge login in subprocess with SSE streaming
    if body.channel == "whatsapp":
        return StreamingResponse(
            _whatsapp_login_stream(mgr),
            media_type="text/event-stream",
        )

    # For other channels: simple login
    channel = mgr.get_channel(body.channel)
    if channel is None:
        raise HTTPException(404, f"Channel {body.channel} not configured")

    try:
        result = await channel.login(force=True)
        return {"ok": result, "message": "Login completed" if result else "Login failed"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


async def _whatsapp_login_stream(mgr):
    """Run WhatsApp bridge login and yield SSE events with QR codes."""
    yield _sse({"status": "starting", "message": "Preparing WhatsApp login..."})

    # Ensure bridge is set up
    try:
        from app.channels.helpers import get_bridge_install_dir
        bridge_dir = get_bridge_install_dir()

        # Check if bridge is built
        if not (bridge_dir / "dist" / "index.js").exists():
            # Try to find bridge from the bundled source
            bundled = Path(__file__).parent.parent / "channels" / "bridge"
            if bundled.exists():
                # Install and build
                yield _sse({"status": "progress", "message": "Installing WhatsApp bridge..."})
                npm = shutil.which("npm")
                if not npm:
                    yield _sse({"status": "error", "message": "npm not found. Install Node.js first."})
                    return

                import shutil as _shutil
                if bridge_dir != bundled:
                    _shutil.copytree(str(bundled), str(bridge_dir), dirs_exist_ok=True)

                proc = await asyncio.create_subprocess_exec(
                    npm, "install",
                    cwd=str(bridge_dir),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc.wait()
                if proc.returncode != 0:
                    stderr = (await proc.stderr.read()).decode()
                    yield _sse({"status": "error", "message": f"Bridge install failed: {stderr[:300]}"})
                    return

                proc = await asyncio.create_subprocess_exec(
                    npm, "run", "build",
                    cwd=str(bridge_dir),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc.wait()
                if proc.returncode != 0:
                    stderr = (await proc.stderr.read()).decode()
                    yield _sse({"status": "error", "message": f"Bridge build failed: {stderr[:300]}"})
                    return
            else:
                yield _sse({"status": "error", "message": "WhatsApp bridge not found."})
                return
    except Exception as e:
        yield _sse({"status": "error", "message": f"Bridge setup failed: {e}"})
        return

    # Prepare bridge token and auth
    from app.channels.helpers import get_runtime_subdir
    import secrets

    auth_dir = get_runtime_subdir("whatsapp-auth")
    token_path = auth_dir / "bridge-token"
    if token_path.exists():
        bridge_token = token_path.read_text(encoding="utf-8").strip()
    else:
        bridge_token = secrets.token_urlsafe(32)
        token_path.write_text(bridge_token, encoding="utf-8")

    env = {**os.environ}
    env["BRIDGE_TOKEN"] = bridge_token
    env["AUTH_DIR"] = str(auth_dir)

    npm = shutil.which("npm")
    if not npm:
        node = shutil.which("node")
        if not node:
            yield _sse({"status": "error", "message": "Node.js not found."})
            return
        cmd = [node, str(bridge_dir / "dist" / "index.js")]
    else:
        cmd = [npm, "start"]

    yield _sse({"status": "starting", "message": "Starting WhatsApp login..."})

    # Run bridge process and stream stdout for QR codes
    q: _queue.Queue[str | None] = _queue.Queue()

    def _reader(proc: subprocess.Popen) -> None:
        try:
            assert proc.stdout is not None
            for raw in proc.stdout:
                q.put(raw.decode(errors="replace").rstrip("\n"))
        except Exception:
            pass
        finally:
            q.put(None)

    proc = subprocess.Popen(
        cmd,
        cwd=str(bridge_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    t = threading.Thread(target=_reader, args=(proc,), daemon=True)
    t.start()

    qr_lines: list[str] = []
    collecting_qr = False
    deadline = asyncio.get_event_loop().time() + 180  # 3 minute timeout

    try:
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                yield _sse({"status": "error", "message": "Login timed out"})
                break

            try:
                line = await asyncio.to_thread(q.get, True, min(remaining, 2.0))
            except Exception:
                continue

            if line is None:
                break

            # Strip ANSI codes
            clean = re.sub(r"\x1b\[\??\d*[a-zA-Z]", "", line)
            clean = re.sub(r"\x1b\[[0-9;]*m", "", clean)

            # Detect QR code data URL
            if "data:image/" in clean:
                match = re.search(r"(data:image/[^\"'\s]+)", clean)
                if match:
                    yield _sse({"status": "qr", "qr_data_url": match.group(1)})
                    continue

            # Detect Unicode block QR
            block_count = sum(1 for c in clean if "\u2580" <= c <= "\u259f")
            if block_count > 10:
                collecting_qr = True
                qr_lines.append(clean)
                continue

            if collecting_qr and block_count <= 10:
                collecting_qr = False
                if qr_lines:
                    qr_text = "\n".join(qr_lines)
                    data_url = _text_qr_to_data_url(qr_text)
                    if data_url:
                        yield _sse({"status": "qr", "qr_data_url": data_url})
                    else:
                        yield _sse({"status": "qr_text", "qr_text": qr_text})
                    qr_lines = []

            stripped = clean.strip()
            if not stripped:
                continue

            lower = stripped.lower()
            if any(p in lower for p in [
                "successfully", "logged in", "is now linked",
                "is ready", "linked!", "pairing complete",
                "account linked", "connection established",
            ]):
                yield _sse({"status": "connected", "message": stripped})
                break

            if "scan" in lower or "qr" in lower:
                yield _sse({"status": "waiting", "message": stripped})
                continue

            yield _sse({"status": "progress", "message": stripped})

        # Flush remaining QR
        if qr_lines:
            qr_text = "\n".join(qr_lines)
            data_url = _text_qr_to_data_url(qr_text)
            if data_url:
                yield _sse({"status": "qr", "qr_data_url": data_url})
            else:
                yield _sse({"status": "qr_text", "qr_text": qr_text})

    except Exception as e:
        yield _sse({"status": "error", "message": str(e)})
    finally:
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.terminate()
        t.join(timeout=5)

    if proc.returncode == 0:
        yield _sse({"status": "connected", "message": "WhatsApp login successful!"})
    elif proc.returncode is not None and proc.returncode != 0:
        yield _sse({"status": "done", "message": "Login process completed"})


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _text_qr_to_data_url(qr_text: str) -> str | None:
    """Convert Unicode block-character QR text to a PNG data URL."""
    try:
        import base64
        import io
        from PIL import Image
    except ImportError:
        return None

    lines = qr_text.split("\n")
    if not lines:
        return None

    width = max(len(l) for l in lines)

    pixels: list[list[bool]] = []
    for line in lines:
        top_row: list[bool] = []
        bot_row: list[bool] = []
        for ch in line:
            if ch == "\u2588":
                top_row.append(True); bot_row.append(True)
            elif ch == "\u2580":
                top_row.append(True); bot_row.append(False)
            elif ch == "\u2584":
                top_row.append(False); bot_row.append(True)
            elif ch == " ":
                top_row.append(False); bot_row.append(False)
            else:
                top_row.append(True); bot_row.append(True)
        while len(top_row) < width:
            top_row.append(False); bot_row.append(False)
        pixels.append(top_row)
        pixels.append(bot_row)

    if not pixels or not pixels[0]:
        return None

    scale = 4
    img_w = len(pixels[0]) * scale
    img_h = len(pixels) * scale
    img = Image.new("1", (img_w, img_h), 1)

    for y, row in enumerate(pixels):
        for x, is_black in enumerate(row):
            if is_black:
                for dy in range(scale):
                    for dx in range(scale):
                        img.putpixel((x * scale + dx, y * scale + dy), 0)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{b64}"


@router.post("/channels/remove")
async def remove_channel(request: Request, body: ChannelRemoveRequest) -> dict:
    """Remove a channel — stops it and removes from config."""
    # Stop the running channel
    mgr = _get_channel_manager(request)
    if mgr:
        channel = mgr.get_channel(body.channel)
        if channel:
            try:
                await channel.stop()
            except Exception as e:
                logger.warning("Error stopping %s: %s", body.channel, e)
        mgr.remove_channel(body.channel)

    # Remove from config
    config = _load_config_dict()
    channels = config.get("channels", {})
    if body.channel in channels:
        del channels[body.channel]
        _save_config_dict(config)

    return {"ok": True, "message": f"{body.channel} removed"}
