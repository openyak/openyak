"""Tests for file attachment prompt rendering."""

from __future__ import annotations

from app.session.manager import _build_user_content_with_files


def test_directory_attachment_renders_as_directory_reference(tmp_path):
    folder = tmp_path / "source"
    folder.mkdir()

    content = _build_user_content_with_files(
        "Please summarize this folder.",
        [
            {
                "name": "source",
                "path": str(folder),
                "size": 0,
                "mime_type": "inode/directory",
            },
        ],
    )

    assert content[0] == {"type": "text", "text": "Please summarize this folder."}
    assert content[1]["type"] == "text"
    assert "<directory" in content[1]["text"]
    assert str(folder) in content[1]["text"]
    assert "Use the Read, Glob, Grep, or code_execute tools" in content[1]["text"]
