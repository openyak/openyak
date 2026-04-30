"""Tests for file attachment API endpoints."""

from __future__ import annotations

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
