"""Tests for ``app.rapid_mlx.detect``."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from app.rapid_mlx.detect import detect_rapid_mlx


@pytest.mark.asyncio
async def test_returns_not_installed_when_binary_missing():
    with patch("app.rapid_mlx.detect.shutil.which", return_value=None):
        status = await detect_rapid_mlx()
    assert status.installed is False
    assert status.binary_path == ""
    assert status.version == ""
    assert status.default_base_url == "http://localhost:8000/v1"


@pytest.mark.asyncio
async def test_reads_version_when_binary_present(tmp_path):
    fake_binary = tmp_path / "rapid-mlx"
    fake_binary.write_text("")

    class _Proc:
        returncode = 0

        async def communicate(self):
            return (b"rapid-mlx 0.6.23\n", b"")

    async def _spawn(*_args, **_kwargs):
        return _Proc()

    with (
        patch("app.rapid_mlx.detect.shutil.which", return_value=str(fake_binary)),
        patch("app.rapid_mlx.detect.asyncio.create_subprocess_exec", side_effect=_spawn),
    ):
        status = await detect_rapid_mlx()
    assert status.installed is True
    assert status.binary_path == str(fake_binary)
    assert status.version == "rapid-mlx 0.6.23"


@pytest.mark.asyncio
async def test_returns_empty_version_on_subprocess_failure():
    class _Proc:
        returncode = 1

        async def communicate(self):
            return (b"", b"boom")

    async def _spawn(*_args, **_kwargs):
        return _Proc()

    with (
        patch("app.rapid_mlx.detect.shutil.which", return_value="/usr/local/bin/rapid-mlx"),
        patch("app.rapid_mlx.detect.asyncio.create_subprocess_exec", side_effect=_spawn),
    ):
        status = await detect_rapid_mlx()
    assert status.installed is True
    assert status.version == ""


@pytest.mark.asyncio
async def test_returns_empty_version_on_timeout():
    class _Proc:
        returncode = None
        killed = False

        async def communicate(self):
            await asyncio.sleep(10)
            return (b"", b"")

        def kill(self):
            self.killed = True

        async def wait(self):
            return 0

    async def _spawn(*_args, **_kwargs):
        return _Proc()

    with (
        patch("app.rapid_mlx.detect.shutil.which", return_value="/usr/local/bin/rapid-mlx"),
        patch("app.rapid_mlx.detect.asyncio.create_subprocess_exec", side_effect=_spawn),
        patch("app.rapid_mlx.detect._VERSION_TIMEOUT", 0.05),
    ):
        status = await detect_rapid_mlx()
    assert status.installed is True
    assert status.version == ""
