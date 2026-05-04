"""Tests for file attachment API endpoints."""

from __future__ import annotations

import logging

import pytest

pytestmark = pytest.mark.asyncio


class TestAttachByPath:
    async def test_attach_accepts_files_and_directories(self, app_client, tmp_path):
        note = tmp_path / "note.md"
        note.write_text("# Note\n", encoding="utf-8")
        folder = tmp_path / "project-folder"
        folder.mkdir()

        resp = await app_client.post(
            "/api/files/attach",
            json={"paths": [str(note), str(folder), str(tmp_path / "missing.txt")]},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert [item["name"] for item in data] == ["note.md", "project-folder"]
        assert data[0]["path"] == str(note.resolve())
        assert data[0]["source"] == "referenced"
        assert data[1]["path"] == str(folder.resolve())
        assert data[1]["mime_type"] == "inode/directory"
        assert data[1]["size"] == 0


def _telemetry_lines(caplog: pytest.LogCaptureFixture, event: str) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "app.api.files"
        and r.getMessage().startswith("telemetry.files_browse ")
        and f"event={event}" in r.getMessage()
    ]


class TestBrowseTelemetry:
    """ADR-0010: every /files/browse* hit emits one structured log line."""

    async def test_browse_files_success(self, app_client, tmp_path, monkeypatch, caplog):
        target = tmp_path / "doc.md"
        target.write_text("hello", encoding="utf-8")

        async def fake_dialog(**_kw) -> list[str]:
            return [str(target)]

        monkeypatch.setattr("app.api.files._open_native_file_dialog", fake_dialog)
        caplog.set_level(logging.INFO, logger="app.api.files")

        resp = await app_client.post("/api/files/browse", json={"multiple": True, "title": "x"})

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        lines = _telemetry_lines(caplog, "files_browse")
        assert len(lines) == 1
        line = lines[0]
        assert "outcome=success" in line
        assert "paths=1" in line
        assert "caller=" in line
        assert "server=" in line

    async def test_browse_files_cancel(self, app_client, monkeypatch, caplog):
        async def fake_dialog(**_kw) -> list[str]:
            return []

        monkeypatch.setattr("app.api.files._open_native_file_dialog", fake_dialog)
        caplog.set_level(logging.INFO, logger="app.api.files")

        resp = await app_client.post("/api/files/browse", json={})

        assert resp.status_code == 200
        assert resp.json() == []
        lines = _telemetry_lines(caplog, "files_browse")
        assert len(lines) == 1
        assert "outcome=cancel" in lines[0]
        assert "paths=0" in lines[0]

    async def test_browse_files_error_outcome_logged(self, app_client, monkeypatch, caplog):
        # Force the platform-specific dialog to raise so the existing
        # except: log+swallow path fires; telemetry must still record one
        # error line.
        async def boom(*_a, **_kw):
            raise RuntimeError("zenity not installed")

        monkeypatch.setattr("app.api.files._dialog_windows", boom)
        monkeypatch.setattr("app.api.files._dialog_macos", boom)
        monkeypatch.setattr("app.api.files._dialog_linux", boom)
        caplog.set_level(logging.INFO, logger="app.api.files")

        resp = await app_client.post("/api/files/browse", json={})

        assert resp.status_code == 200
        assert resp.json() == []
        lines = _telemetry_lines(caplog, "files_browse")
        # One error line from the helper, one cancel line from the endpoint
        # (the helper returned [] after the error, which the endpoint reads
        # as cancel — that's by design; both lines are useful signal).
        outcomes = sorted(
            line.split("outcome=")[1].split(" ")[0] for line in lines
        )
        assert outcomes == ["cancel", "error"]
        error_line = next(line for line in lines if "outcome=error" in line)
        assert "zenity not installed" in error_line

    async def test_browse_directory_success(self, app_client, monkeypatch, caplog):
        async def fake_dialog(*_a, **_kw) -> str:
            return "/picked/path"

        monkeypatch.setattr("app.api.files._open_native_directory_dialog", fake_dialog)
        caplog.set_level(logging.INFO, logger="app.api.files")

        resp = await app_client.post("/api/files/browse-directory", json={})

        assert resp.status_code == 200
        assert resp.json() == {"path": "/picked/path"}
        lines = _telemetry_lines(caplog, "files_browse_directory")
        assert len(lines) == 1
        assert "outcome=success" in lines[0]
        assert "paths=1" in lines[0]

    async def test_browse_directory_cancel(self, app_client, monkeypatch, caplog):
        async def fake_dialog(*_a, **_kw):
            return None

        monkeypatch.setattr("app.api.files._open_native_directory_dialog", fake_dialog)
        caplog.set_level(logging.INFO, logger="app.api.files")

        resp = await app_client.post("/api/files/browse-directory", json={})

        assert resp.status_code == 200
        assert resp.json() == {"path": None}
        lines = _telemetry_lines(caplog, "files_browse_directory")
        assert len(lines) == 1
        assert "outcome=cancel" in lines[0]
        assert "paths=0" in lines[0]

    async def test_caller_class_tauri_vs_browser(self, app_client, monkeypatch, caplog):
        async def fake_dialog(**_kw) -> list[str]:
            return []

        monkeypatch.setattr("app.api.files._open_native_file_dialog", fake_dialog)
        caplog.set_level(logging.INFO, logger="app.api.files")

        await app_client.post(
            "/api/files/browse",
            json={},
            headers={"User-Agent": "Mozilla/5.0 Tauri/1.0"},
        )
        await app_client.post(
            "/api/files/browse",
            json={},
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/123"},
        )

        lines = _telemetry_lines(caplog, "files_browse")
        assert any("caller=tauri" in line for line in lines)
        assert any("caller=browser" in line for line in lines)
