"""Tests for Ollama runtime manager download helpers."""

from __future__ import annotations

import stat
import tarfile
import zipfile

from app.ollama import manager as manager_module
from app.ollama.manager import OllamaManager


def test_download_urls_match_current_release_assets():
    assert manager_module._DOWNLOAD_URLS["darwin-arm64"].endswith("/ollama-darwin.tgz")
    assert manager_module._DOWNLOAD_URLS["darwin-amd64"].endswith("/ollama-darwin.tgz")
    assert manager_module._DOWNLOAD_URLS["linux-amd64"].endswith("/ollama-linux-amd64.tar.zst")
    assert manager_module._DOWNLOAD_URLS["linux-arm64"].endswith("/ollama-linux-arm64.tar.zst")
    assert manager_module._DOWNLOAD_URLS["windows-amd64"].endswith("/ollama-windows-amd64.zip")
    assert manager_module._DOWNLOAD_URLS["windows-arm64"].endswith("/ollama-windows-arm64.zip")


def test_archive_type_helpers_cover_ollama_release_formats():
    assert manager_module._is_zip("https://example.com/ollama-windows-amd64.zip")
    assert manager_module._is_tar("https://example.com/ollama-darwin.tgz")
    assert manager_module._is_tar("https://example.com/ollama-linux-amd64.tar.zst")
    assert manager_module._download_filename("https://example.com/releases/latest/download/ollama-darwin.tgz", "ollama") == "ollama-darwin.tgz"


def test_extract_tgz_makes_root_binary_executable(tmp_path, monkeypatch):
    monkeypatch.setattr(manager_module.sys, "platform", "darwin")
    mgr = OllamaManager(tmp_path)
    mgr.binary_dir.mkdir(parents=True)
    archive_path = tmp_path / "ollama-darwin.tgz"
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    source_binary = source_dir / "ollama"
    source_binary.write_bytes(b"fake ollama")

    with tarfile.open(archive_path, "w:gz") as tf:
        tf.add(source_binary, arcname="ollama")

    mgr._extract_archive(archive_path)
    mgr._ensure_binary_executable()

    assert mgr.binary_path == mgr.binary_dir / "ollama"
    assert mgr.binary_path.read_bytes() == b"fake ollama"
    assert mgr.binary_path.stat().st_mode & stat.S_IXUSR


def test_binary_path_finds_nested_zip_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(manager_module.sys, "platform", "win32")
    mgr = OllamaManager(tmp_path)
    mgr.binary_dir.mkdir(parents=True)
    archive_path = tmp_path / "ollama-windows-arm64.zip"

    with zipfile.ZipFile(archive_path, "w") as zf:
        zf.writestr("bin/ollama.exe", b"fake ollama")

    mgr._extract_archive(archive_path)
    mgr._ensure_binary_executable()

    assert mgr.binary_path == mgr.binary_dir / "bin" / "ollama.exe"
    assert mgr.is_binary_installed
