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


def test_rapid_mlx_canonicalizes_alias_and_repo():
    assert manager_module.canonical_rapid_mlx_model("qwen3.5-9b") == (
        "mlx-community/qwen3.5-9b-4bit"
    )
    assert manager_module.canonical_rapid_mlx_model(
        "rapid-mlx/mlx-community/Qwen3.5-9B-4bit"
    ) == "mlx-community/qwen3.5-9b-4bit"


def test_rapid_mlx_process_parser_finds_server_on_port():
    output = """
      123 /usr/bin/python /opt/homebrew/bin/rapid-mlx serve qwen3.5-4b --host 127.0.0.1 --port 18080
      456 /usr/bin/python /opt/homebrew/bin/rapid-mlx serve qwen3.5-9b --port=19000
      789 /bin/zsh -c rapid-mlx ps
    """

    assert manager_module._parse_rapid_mlx_server_pid(output, 18080) == 123
    assert manager_module._parse_rapid_mlx_server_pid(output, 19000) == 456
    assert manager_module._parse_rapid_mlx_server_pid(output, 19999) is None


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


@pytest.mark.asyncio
async def test_rapid_mlx_start_replaces_managed_process_on_new_port(
    monkeypatch,
    tmp_path: Path,
):
    calls: list[tuple[str, ...]] = []

    class FakeRunningProcess:
        returncode = None
        terminated = False

        def terminate(self):
            self.terminated = True
            self.returncode = 0

        async def wait(self):
            return self.returncode

    class FakeStartedProcess:
        returncode = None

    async def fake_create_subprocess_exec(*args, **_kwargs):
        calls.append(tuple(args))
        return FakeStartedProcess()

    async def fake_rapid_mlx_running(_base_url: str) -> bool:
        return False

    monkeypatch.setattr(manager_module, "_platform_supported", lambda: True)
    monkeypatch.setattr(manager_module.shutil, "which", lambda _name: "/bin/rapid-mlx")
    monkeypatch.setattr(manager_module, "_rapid_mlx_running", fake_rapid_mlx_running)
    monkeypatch.setattr(
        manager_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    old_process = FakeRunningProcess()
    mgr = RapidMLXManager(tmp_path)
    mgr._process = old_process  # type: ignore[assignment]
    mgr._model = "qwen3.5-4b"
    mgr._port = 18080

    base_url = await mgr.start(model="qwen3.5-9b", port=19000)

    assert base_url == "http://localhost:19000/v1"
    assert old_process.terminated is True
    assert mgr._model == "qwen3.5-9b"
    assert mgr._port == 19000
    assert calls == [
        (
            "/bin/rapid-mlx",
            "serve",
            "qwen3.5-9b",
            "--host",
            "127.0.0.1",
            "--port",
            "19000",
        )
    ]


# ---------------------------------------------------------------------------
# uninstall — freed_bytes accounting + HF cache cleanup
# ---------------------------------------------------------------------------


def _make_hf_cache(root: Path) -> Path:
    """Create a fake HuggingFace hub directory at ``<root>/hub``."""
    hub = root / "hub"
    hub.mkdir(parents=True, exist_ok=True)
    return hub


def _make_cached_repo(hub: Path, repo: str, blob_sizes: list[int]) -> Path:
    """Lay out a model dir mirroring how HF actually structures the cache:
    ``blobs/<sha>`` are the real files, ``snapshots/<rev>/<name>`` are
    symlinks pointing at them.

    Returns the model dir.
    """
    model_dir = hub / f"models--{repo.replace('/', '--')}"
    blobs_dir = model_dir / "blobs"
    blobs_dir.mkdir(parents=True)
    snapshots_dir = model_dir / "snapshots" / "rev1"
    snapshots_dir.mkdir(parents=True)
    refs_dir = model_dir / "refs"
    refs_dir.mkdir(parents=True)
    (refs_dir / "main").write_text("rev1", encoding="utf-8")

    for i, size in enumerate(blob_sizes):
        sha = f"abc{i}"
        blob = blobs_dir / sha
        blob.write_bytes(b"\0" * size)
        # snapshot file is a symlink → blob
        snap = snapshots_dir / f"file{i}.bin"
        snap.symlink_to(blob)
    return model_dir


@pytest.mark.asyncio
async def test_uninstall_filters_symlinks_when_counting_freed_bytes(
    monkeypatch, tmp_path: Path
):
    """HF cache layout uses snapshots/<rev>/file → blobs/<sha> symlinks.
    rglob+stat follows symlinks, so naively summing every "file" would
    double-count the real blob through its snapshot pointer. The fix
    must skip symlinks and count blobs only.
    """
    hub = _make_hf_cache(tmp_path)
    # Two blobs: 1000 + 2500 bytes — both reachable via symlinks too.
    # Plus the refs/main pointer file (4 bytes — "rev1").
    target_sizes = [1000, 2500]
    expected_freed = sum(target_sizes) + len("rev1")

    # Use the first known alias from the catalog so resolve_rapid_mlx_repo
    # produces a stable repo path.
    from app.rapid_mlx.catalog import RAPID_MLX_ALIAS_REPOS, resolve_rapid_mlx_repo

    target_alias = next(iter(RAPID_MLX_ALIAS_REPOS))
    target_repo = resolve_rapid_mlx_repo(target_alias)
    _make_cached_repo(hub, target_repo, target_sizes)
    naive_double = sum(target_sizes) * 2 + len("rev1")

    monkeypatch.setattr(manager_module, "_huggingface_cache_dir", lambda: hub)
    # Treat the binary as already gone — uninstall.stop() should no-op
    # cleanly (nothing is running) and we focus on the cleanup path.
    monkeypatch.setattr(
        manager_module,
        "_rapid_mlx_running",
        lambda _url: _coro(False),
    )

    mgr = RapidMLXManager(tmp_path)

    summary = await mgr.uninstall(delete_models=True)

    assert summary["removed_models"] == [target_repo]
    # The big check: freed_bytes is the real blob size, NOT 2× (which is
    # what we'd get if symlinks weren't filtered).
    assert summary["freed_bytes"] == expected_freed, (
        f"got {summary['freed_bytes']}, expected {expected_freed} "
        f"(naive symlink-following would have given {naive_double})"
    )
    # Directory is actually gone.
    assert not (hub / f"models--{target_repo.replace('/', '--')}").exists()


@pytest.mark.asyncio
async def test_uninstall_skips_uncached_models(monkeypatch, tmp_path: Path):
    """If a known alias isn't cached on disk, it shouldn't show up in
    removed_models — and shouldn't contribute to freed_bytes."""
    hub = _make_hf_cache(tmp_path)
    monkeypatch.setattr(manager_module, "_huggingface_cache_dir", lambda: hub)
    monkeypatch.setattr(
        manager_module,
        "_rapid_mlx_running",
        lambda _url: _coro(False),
    )

    mgr = RapidMLXManager(tmp_path)
    summary = await mgr.uninstall(delete_models=True)

    assert summary["removed_models"] == []
    assert summary["freed_bytes"] == 0


@pytest.mark.asyncio
async def test_uninstall_keeps_models_when_flag_false(monkeypatch, tmp_path: Path):
    """delete_models=False should leave HF cache untouched."""
    hub = _make_hf_cache(tmp_path)
    from app.rapid_mlx.catalog import RAPID_MLX_ALIAS_REPOS, resolve_rapid_mlx_repo

    target_repo = resolve_rapid_mlx_repo(next(iter(RAPID_MLX_ALIAS_REPOS)))
    cache_dir = _make_cached_repo(hub, target_repo, [500])

    monkeypatch.setattr(manager_module, "_huggingface_cache_dir", lambda: hub)
    monkeypatch.setattr(
        manager_module,
        "_rapid_mlx_running",
        lambda _url: _coro(False),
    )

    mgr = RapidMLXManager(tmp_path)
    summary = await mgr.uninstall(delete_models=False)

    assert summary["removed_models"] == []
    assert summary["freed_bytes"] == 0
    assert cache_dir.exists()


def test_uninstall_includes_binary_removal_commands(monkeypatch, tmp_path: Path):
    """The dialog renders these so the user can copy/paste — keep
    brew + pip both in the response."""
    hub = _make_hf_cache(tmp_path)
    monkeypatch.setattr(manager_module, "_huggingface_cache_dir", lambda: hub)
    monkeypatch.setattr(
        manager_module,
        "_rapid_mlx_running",
        lambda _url: _coro(False),
    )

    mgr = RapidMLXManager(tmp_path)
    import asyncio as _asyncio

    summary = _asyncio.run(mgr.uninstall(delete_models=False))
    cmds = summary["binary_install_commands"]
    assert any("brew uninstall" in c for c in cmds)
    assert any("pip uninstall rapid-mlx" in c for c in cmds)


async def _coro(value):
    """Helper: turn a value into an awaitable, since the function under
    test does ``await _rapid_mlx_running(...)``."""
    return value
