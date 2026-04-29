"""Slow Ollama manager integration test.

Run explicitly with:
OPENYAK_RUN_OLLAMA_E2E=1 pytest tests/test_ollama/test_manager_e2e.py -q
"""

from __future__ import annotations

import json
import os

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api import ollama as ollama_api
from app.ollama.manager import OllamaManager


pytestmark = pytest.mark.skipif(
    os.environ.get("OPENYAK_RUN_OLLAMA_E2E") != "1",
    reason="set OPENYAK_RUN_OLLAMA_E2E=1 to download Ollama and a small Qwen model",
)

_MODEL = "qwen2.5:0.5b"


async def _setup_via_api(mgr: OllamaManager, monkeypatch: pytest.MonkeyPatch) -> str:
    app = FastAPI()
    app.state.ollama_manager = mgr
    app.include_router(ollama_api.router)

    async def _register_noop(base_url: str) -> None:
        return None

    monkeypatch.setattr(ollama_api, "_register_ollama_provider", _register_noop)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        async with client.stream("POST", "/ollama/setup") as resp:
            resp.raise_for_status()
            ready_base_url = None
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line.removeprefix("data: "))
                if event.get("status") == "error":
                    raise RuntimeError(event.get("message"))
                if event.get("status") == "ready":
                    ready_base_url = event["base_url"]

    assert ready_base_url is not None
    return ready_base_url


async def _pull_model(base_url: str, model: str) -> None:
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            f"{base_url}/api/pull",
            json={"name": model, "stream": True},
        ) as resp:
            resp.raise_for_status()
            async for _ in resp.aiter_lines():
                pass


async def _chat_once(base_url: str, model: str) -> str:
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(
            f"{base_url}/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [{"role": "user", "content": "Reply with exactly: OpenYak Ollama OK"}],
                "options": {"temperature": 0},
            },
        )
        resp.raise_for_status()
        return resp.json()["message"]["content"].strip()


@pytest.mark.asyncio
async def test_install_chat_and_uninstall_with_small_qwen_model(tmp_path, monkeypatch):
    mgr = OllamaManager(data_dir=tmp_path)

    try:
        base_url = await _setup_via_api(mgr, monkeypatch)
        assert mgr.is_binary_installed
        assert base_url.startswith("http://127.0.0.1:")
        assert await mgr.get_version()

        await _pull_model(base_url, _MODEL)
        reply = await _chat_once(base_url, _MODEL)
        assert "OpenYak" in reply
        assert "OK" in reply

        result = await mgr.uninstall(delete_models=True)
        assert result["binary"] is True
        assert result["models"] is True
        assert not mgr.binary_dir.exists()
        assert not mgr.models_dir.exists()
    finally:
        if mgr.is_running:
            await mgr.stop()
