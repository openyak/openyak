"""Tests for Rapid-MLX runtime manager helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.rapid_mlx import manager as manager_module
from app.rapid_mlx.manager import RapidMLXManager


def test_rapid_mlx_binary_detection_checks_homebrew_paths(monkeypatch, tmp_path: Path):
    fake_binary = tmp_path / "rapid-mlx"
    fake_binary.write_text("#!/bin/sh\n", encoding="utf-8")

    monkeypatch.setattr(manager_module.shutil, "which", lambda _name: None)
    monkeypatch.setattr(manager_module, "_COMMON_BINARY_PATHS", (str(fake_binary),))

    mgr = RapidMLXManager(tmp_path)

    assert mgr.executable_path == str(fake_binary)
    assert mgr.is_binary_installed is True


def test_rapid_mlx_port_parsing():
    assert manager_module._port_from_base_url("http://localhost:8000/v1") == 8000
    assert manager_module._port_from_base_url("https://example.test/v1") is None


def test_rapid_mlx_cached_model_detection_uses_huggingface_cache(
    monkeypatch,
    tmp_path: Path,
):
    cache_dir = tmp_path / "hub"
    snapshot = (
        cache_dir
        / "models--mlx-community--Qwen3.5-4B-MLX-4bit"
        / "snapshots"
        / "abc123"
    )
    snapshot.mkdir(parents=True)
    monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))

    mgr = RapidMLXManager(tmp_path)

    assert mgr.is_model_cached("qwen3.5-4b") is True
    assert mgr.cached_models(["qwen3.5-4b", "qwen3.5-27b"]) == {
        "qwen3.5-4b": True,
        "qwen3.5-27b": False,
    }


@pytest.mark.asyncio
async def test_rapid_mlx_remove_model_invokes_cli(monkeypatch, tmp_path: Path):
    calls: list[tuple[str, ...]] = []

    class FakeProcess:
        returncode = 0

        async def communicate(self):
            return b"removed", b""

    async def fake_create_subprocess_exec(*args, **_kwargs):
        calls.append(tuple(args))
        return FakeProcess()

    monkeypatch.setattr(manager_module, "_platform_supported", lambda: True)
    monkeypatch.setattr(manager_module.shutil, "which", lambda _name: "/bin/rapid-mlx")
    monkeypatch.setattr(
        manager_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    mgr = RapidMLXManager(tmp_path)
    await mgr.remove_model("qwen3.5-4b")

    assert calls == [("/bin/rapid-mlx", "rm", "mlx-community/Qwen3.5-4B-MLX-4bit")]


def test_rapid_mlx_gemma_alias_matches_rapid_mlx_cli_cache_mapping():
    assert (
        manager_module._ALIAS_REPOS["gemma-4-26b"]
        == "mlx-community/gemma-4-26b-a4b-it-4bit"
    )
    assert (
        manager_module._ALIAS_REPOS["gemma-4-31b"]
        == "mlx-community/gemma-4-31b-it-4bit"
    )


@pytest.mark.asyncio
async def test_rapid_mlx_remove_model_rejects_running_model(monkeypatch, tmp_path: Path):
    class FakeRunningProcess:
        returncode = None

    monkeypatch.setattr(manager_module, "_platform_supported", lambda: True)
    monkeypatch.setattr(manager_module.shutil, "which", lambda _name: "/bin/rapid-mlx")

    mgr = RapidMLXManager(tmp_path)
    mgr._process = FakeRunningProcess()  # type: ignore[assignment]
    mgr._model = "qwen3.5-4b"

    with pytest.raises(RuntimeError, match="Stop Rapid-MLX"):
        await mgr.remove_model("qwen3.5-4b")
