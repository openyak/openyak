"""Process lifecycle helpers for Rapid-MLX on Apple Silicon Macs."""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any

import httpx

from app.provider.rapid_mlx import DEFAULT_BASE_URL, DEFAULT_MODEL

DEFAULT_PORT = 18080

_COMMON_BINARY_PATHS = (
    "/opt/homebrew/bin/rapid-mlx",
    "/usr/local/bin/rapid-mlx",
)


def _platform_supported() -> bool:
    return sys.platform == "darwin" and platform.machine().lower() in {
        "arm64",
        "aarch64",
    }


def _base_url_for_port(port: int) -> str:
    return f"http://localhost:{port}/v1"


def _server_root_for_port(port: int) -> str:
    return f"http://localhost:{port}"


class RapidMLXManager:
    """Start, stop, and inspect a local ``rapid-mlx serve`` process."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self._process: asyncio.subprocess.Process | None = None
        self._port = DEFAULT_PORT
        self._model = DEFAULT_MODEL

    @property
    def executable_path(self) -> str | None:
        found = shutil.which("rapid-mlx")
        if found:
            return found
        for candidate in _COMMON_BINARY_PATHS:
            if Path(candidate).exists():
                return candidate
        return None

    @property
    def platform_supported(self) -> bool:
        return _platform_supported()

    @property
    def is_binary_installed(self) -> bool:
        return self.executable_path is not None

    @property
    def is_managed_process_alive(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def status(
        self,
        *,
        configured_base_url: str = "",
        configured_model: str = "",
    ) -> dict[str, Any]:
        base_url = configured_base_url or _base_url_for_port(self._port)
        port = _port_from_base_url(base_url) or self._port
        running = await _rapid_mlx_running(base_url)
        version = await self._version() if self.is_binary_installed else None
        model = configured_model or self._model or DEFAULT_MODEL
        return {
            "platform_supported": self.platform_supported,
            "binary_installed": self.is_binary_installed,
            "running": running,
            "process_running": self.is_managed_process_alive,
            "port": port,
            "base_url": base_url if running or configured_base_url else None,
            "version": version,
            "current_model": model,
            "executable_path": self.executable_path,
            "install_commands": [
                "brew install raullenchai/rapid-mlx/rapid-mlx",
                "pip install rapid-mlx",
            ],
        }

    async def start(self, *, model: str = DEFAULT_MODEL, port: int = DEFAULT_PORT) -> str:
        if not self.platform_supported:
            raise RuntimeError("Rapid-MLX is supported only on Apple Silicon macOS.")
        executable = self.executable_path
        if not executable:
            raise RuntimeError("rapid-mlx is not installed.")

        self._port = port
        self._model = model.strip() or DEFAULT_MODEL
        base_url = _base_url_for_port(port)
        if await _rapid_mlx_running(base_url):
            return base_url

        if self.is_managed_process_alive:
            return base_url

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        self._process = await asyncio.create_subprocess_exec(
            executable,
            "serve",
            self._model,
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            cwd=str(self.data_dir),
            env=env,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return base_url

    async def stop(self) -> None:
        if not self.is_managed_process_alive or self._process is None:
            raise RuntimeError("Rapid-MLX was not started by OpenYak in this session.")
        self._process.terminate()
        try:
            await asyncio.wait_for(self._process.wait(), timeout=8)
        except TimeoutError:
            self._process.kill()
            await self._process.wait()

    async def _version(self) -> str | None:
        executable = self.executable_path
        if not executable:
            return None
        try:
            proc = await asyncio.create_subprocess_exec(
                executable,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=3)
            text = (stdout or stderr).decode("utf-8", errors="ignore").strip()
            return text or None
        except Exception:
            return None


async def _rapid_mlx_running(base_url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/models")
            if resp.status_code != 200:
                return False
            data = resp.json()
            return isinstance(data.get("data"), list)
    except Exception:
        return False


def _port_from_base_url(base_url: str) -> int | None:
    try:
        from urllib.parse import urlparse

        parsed = urlparse(base_url)
        return parsed.port
    except Exception:
        return None


def server_root_from_base_url(base_url: str) -> str:
    port = _port_from_base_url(base_url) or DEFAULT_PORT
    return _server_root_for_port(port)
