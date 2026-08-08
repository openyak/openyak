"""Tests for remote access API endpoints."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.remote import router
from app.auth.tunnel import TunnelManager
from tests.platform_support import requires_posix_shebang

pytestmark = pytest.mark.asyncio


class TestEnableRemote:
    @requires_posix_shebang
    async def test_recovers_when_bundled_cloudflared_is_invalid(self, monkeypatch, tmp_path: Path):
        bad_bin_dir = tmp_path / "data" / "bin"
        bad_bin_dir.mkdir(parents=True)

        bad_binary = bad_bin_dir / "cloudflared"
        bad_binary.write_text("not a real executable\n", encoding="utf-8")
        bad_binary.chmod(0o755)

        token_path = tmp_path / "data" / "remote_token.json"

        app = FastAPI()
        app.include_router(router, prefix="/api")
        app.state.settings = SimpleNamespace(
            remote_token_path=str(token_path),
            remote_access_enabled=False,
            remote_tunnel_mode="cloudflare",
            remote_tunnel_url="",
            remote_permission_mode="auto",
            port=8000,
        )

        class TestTunnelManager(TunnelManager):
            def __init__(self, *args, bin_dir: Path | None = None, **kwargs):
                super().__init__(*args, bin_dir=bad_bin_dir, **kwargs)

            async def _download(self, target: Path) -> Path:
                target.write_text(
                    "#!/bin/sh\n"
                    "printf 'https://recovered.trycloudflare.com\\n'\n"
                    "sleep 1\n",
                    encoding="utf-8",
                )
                target.chmod(0o755)
                return target

        monkeypatch.setattr("app.auth.tunnel.shutil.which", lambda _: None)
        monkeypatch.setattr("app.auth.tunnel.TunnelManager", TestTunnelManager)

        transport = ASGITransport(app=app, client=("127.0.0.1", 12345))
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post("/api/remote/enable")

        assert response.status_code == 200
        data = response.json()
        assert data["token"]
        assert data["tunnel_url"] == "https://recovered.trycloudflare.com"
        assert bad_binary.read_text(encoding="utf-8").startswith("#!/bin/sh")

        tunnel_mgr = app.state.tunnel_manager
        await tunnel_mgr.stop()
        assert tunnel_mgr._monitor_task is None
