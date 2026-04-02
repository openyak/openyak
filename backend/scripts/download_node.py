#!/usr/bin/env python3
"""Download a minimal Node.js 22 runtime for bundling with OpenYak desktop.

Usage:
    python scripts/download_node.py [--output resources/nodejs]

Downloads the correct Node.js binary for the current platform, extracts only
the essential files (~30 MB), and places them in the output directory.

The resulting layout:
    resources/nodejs/
        node.exe          (Windows)
        node              (macOS / Linux)
        npm.cmd / npm     (Windows / Unix)
        npx.cmd / npx     (Windows / Unix)
        node_modules/npm/ (npm package)
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import platform
import shutil
import stat
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

NODE_VERSION = "22.22.0"

# Official Node.js download URLs per platform
_URLS = {
    ("Windows", "AMD64"): f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-x64.zip",
    ("Windows", "ARM64"): f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-arm64.zip",
    ("Darwin", "x86_64"): f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-darwin-x64.tar.gz",
    ("Darwin", "arm64"): f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-darwin-arm64.tar.gz",
    ("Linux", "x86_64"): f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz",
    ("Linux", "aarch64"): f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-arm64.tar.xz",
}

# Files to keep from the Node.js distribution (relative to the root inside archive)
_KEEP_PREFIXES_WIN = {"node.exe", "npm", "npm.cmd", "npx", "npx.cmd", "node_modules/npm/"}
_KEEP_PREFIXES_UNIX = {"bin/node", "bin/npm", "bin/npx", "lib/node_modules/npm/"}


def _platform_key() -> tuple[str, str]:
    system = platform.system()
    machine = platform.machine()
    # Normalize
    if machine in ("x86_64", "AMD64"):
        machine = "AMD64" if system == "Windows" else "x86_64"
    elif machine in ("arm64", "aarch64", "ARM64"):
        machine = "ARM64" if system == "Windows" else ("arm64" if system == "Darwin" else "aarch64")
    return system, machine


def _download(url: str) -> bytes:
    import ssl

    import certifi

    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    print(f"Downloading {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "OpenYak-Builder/1.0"})
    with urllib.request.urlopen(req, timeout=120, context=ssl_ctx) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        data = bytearray()
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if total:
                pct = len(data) * 100 // total
                print(f"\r  {len(data) // (1024*1024)} MB / {total // (1024*1024)} MB ({pct}%)", end="", flush=True)
        print()
    return bytes(data)


def _extract_windows(archive_bytes: bytes, output: Path) -> None:
    """Extract minimal files from Windows .zip archive."""
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
        # Find the root dir inside the zip (e.g. "node-v22.22.0-win-x64/")
        root = zf.namelist()[0].split("/")[0] + "/"
        for info in zf.infolist():
            if info.is_dir():
                continue
            rel = info.filename[len(root):]
            if not rel:
                continue
            if not any(rel == p or rel.startswith(p) for p in _KEEP_PREFIXES_WIN):
                continue
            dest = output / rel.replace("/", os.sep)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            print(f"  {rel}")


def _extract_unix(archive_bytes: bytes, output: Path) -> None:
    """Extract minimal files from macOS/Linux tar.gz or tar.xz archive."""
    output.mkdir(parents=True, exist_ok=True)
    mode = "r:gz" if archive_bytes[:2] == b'\x1f\x8b' else "r:xz"
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode=mode) as tf:
        root = tf.getnames()[0].split("/")[0] + "/"
        for member in tf.getmembers():
            if member.isdir():
                continue
            rel = member.name[len(root):]
            if not rel:
                continue
            if not any(rel == p or rel.startswith(p) for p in _KEEP_PREFIXES_UNIX):
                continue
            dest = output / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            src = tf.extractfile(member)
            if src:
                with open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                # Preserve executable bits
                if member.mode & stat.S_IXUSR:
                    dest.chmod(dest.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            print(f"  {rel}")


def main():
    parser = argparse.ArgumentParser(description="Download Node.js runtime for bundling")
    parser.add_argument("--output", default="resources/nodejs", help="Output directory")
    parser.add_argument("--platform", help="Override platform (e.g. 'Darwin-arm64')")
    args = parser.parse_args()

    if args.platform:
        parts = args.platform.split("-")
        key = (parts[0], parts[1])
    else:
        key = _platform_key()

    url = _URLS.get(key)
    if not url:
        print(f"ERROR: Unsupported platform: {key}", file=sys.stderr)
        print(f"Supported: {list(_URLS.keys())}", file=sys.stderr)
        sys.exit(1)

    output = Path(args.output)
    if output.exists():
        print(f"Removing existing {output} ...")
        shutil.rmtree(output)

    data = _download(url)
    print(f"Downloaded {len(data) // (1024*1024)} MB")

    is_win = key[0] == "Windows"
    if is_win:
        _extract_windows(data, output)
    else:
        _extract_unix(data, output)

    # Verify
    node_bin = output / ("node.exe" if is_win else "bin" / Path("node"))
    if node_bin.exists():
        print(f"\nNode.js {NODE_VERSION} ready at: {output}")
        # Show size
        total_size = sum(f.stat().st_size for f in output.rglob("*") if f.is_file())
        print(f"Total size: {total_size // (1024*1024)} MB")
    else:
        print(f"ERROR: node binary not found at {node_bin}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
