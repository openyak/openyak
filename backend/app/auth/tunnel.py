"""Cloudflare Tunnel manager — exposes localhost backend over the internet.

Uses `cloudflared` in "quick tunnel" mode (no account required).
Generates a random *.trycloudflare.com URL with automatic HTTPS.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

from app.tool.subprocess_compat import get_subprocess_kwargs

logger = logging.getLogger(__name__)

# Pattern to extract tunnel URL from cloudflared output
_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# Download URLs by platform
_DOWNLOAD_URLS = {
    ("Windows", "AMD64"): "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
    ("Windows", "x86_64"): "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
    ("Linux", "x86_64"): "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
    ("Darwin", "x86_64"): "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
    ("Darwin", "arm64"): "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
}


class TunnelManager:
    """Manages a cloudflared tunnel subprocess."""

    def __init__(self, backend_port: int = 8000, bin_dir: Path | None = None):
        self._port = backend_port
        self._bin_dir = bin_dir or Path("data/bin")
        self._process: subprocess.Popen | None = None
        self._tunnel_url: str | None = None
        self._monitor_task: asyncio.Task | None = None

    @property
    def tunnel_url(self) -> str | None:
        return self._tunnel_url

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    async def start(self) -> str:
        """Start cloudflared tunnel. Returns the tunnel URL."""
        # Cancel any existing monitor task to prevent duplicates on restart
        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()
            self._monitor_task = None

        binary = await self._ensure_binary()

        logger.info("Starting cloudflared tunnel on port %d...", self._port)

        self._process = subprocess.Popen(
            [str(binary), "tunnel", "--url", f"http://localhost:{self._port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            **get_subprocess_kwargs(),
        )

        # Read output to find the tunnel URL (with timeout)
        url = await asyncio.wait_for(
            self._read_tunnel_url(),
            timeout=30.0,
        )
        self._tunnel_url = url
        logger.info("Cloudflare tunnel active: %s", url)

        # Start background monitor
        self._monitor_task = asyncio.create_task(self._monitor(), name="tunnel-monitor")

        return url

    async def stop(self) -> None:
        """Stop the tunnel subprocess."""
        if self._monitor_task:
            self._monitor_task.cancel()
            self._monitor_task = None

        if self._process:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
            self._process = None
            logger.info("Cloudflare tunnel stopped")

        self._tunnel_url = None

    async def _read_tunnel_url(self) -> str:
        """Read cloudflared output until we find the tunnel URL."""
        loop = asyncio.get_running_loop()

        def _read_lines():
            assert self._process and self._process.stdout
            for line in self._process.stdout:
                logger.debug("cloudflared: %s", line.rstrip())
                match = _URL_PATTERN.search(line)
                if match:
                    return match.group(0)
            raise RuntimeError("cloudflared exited without providing a tunnel URL")

        return await loop.run_in_executor(None, _read_lines)

    async def _monitor(self) -> None:
        """Monitor tunnel process health, restart if it dies."""
        try:
            while True:
                await asyncio.sleep(10)
                if self._process and self._process.poll() is not None:
                    logger.warning("cloudflared process died (exit code %d), restarting...",
                                   self._process.returncode)
                    try:
                        await self.start()
                    except Exception as e:
                        logger.error("Failed to restart tunnel: %s", e)
                        break
        except asyncio.CancelledError:
            pass

    async def _ensure_binary(self) -> Path:
        """Ensure cloudflared binary is available."""
        # Check if already in PATH
        which = shutil.which("cloudflared")
        if which:
            return Path(which)

        # Check local bin directory
        ext = ".exe" if platform.system() == "Windows" else ""
        local_bin = self._bin_dir / f"cloudflared{ext}"
        if local_bin.exists():
            return local_bin

        # Download
        return await self._download(local_bin)

    async def _download(self, target: Path) -> Path:
        """Download cloudflared binary."""
        system = platform.system()
        machine = platform.machine()
        url = _DOWNLOAD_URLS.get((system, machine))

        if not url:
            raise RuntimeError(
                f"No cloudflared download available for {system}/{machine}. "
                "Please install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            )

        logger.info("Downloading cloudflared from %s ...", url)
        target.parent.mkdir(parents=True, exist_ok=True)

        loop = asyncio.get_running_loop()

        def _do_download():
            import urllib.request

            if url.endswith(".tgz"):
                import tarfile
                import tempfile

                with tempfile.NamedTemporaryFile(suffix=".tgz", delete=False) as tmp:
                    urllib.request.urlretrieve(url, tmp.name)
                    with tarfile.open(tmp.name, "r:gz") as tf:
                        member = next(m for m in tf.getmembers() if "cloudflared" in m.name)
                        f = tf.extractfile(member)
                        assert f is not None
                        target.write_bytes(f.read())
                    Path(tmp.name).unlink(missing_ok=True)
            else:
                urllib.request.urlretrieve(url, str(target))

            if sys.platform != "win32":
                import stat
                target.chmod(target.stat().st_mode | stat.S_IEXEC)

        await loop.run_in_executor(None, _do_download)
        logger.info("cloudflared downloaded to %s", target)
        return target
