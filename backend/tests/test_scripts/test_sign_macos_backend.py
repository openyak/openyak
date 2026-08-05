from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).parents[3] / "scripts" / "sign_macos_backend.py"
SPEC = importlib.util.spec_from_file_location("sign_macos_backend", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
sign_macos_backend = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sign_macos_backend)


def test_signs_extensionless_playwright_node_and_other_macho_files(tmp_path: Path) -> None:
    backend_dir = tmp_path / "backend"
    playwright_node = backend_dir / "_internal" / "playwright" / "driver" / "node"
    dylib = backend_dir / "_internal" / "libexample.dylib"
    text_file = backend_dir / "README"
    for path in (playwright_node, dylib, text_file):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")

    descriptions = {
        playwright_node: "Mach-O 64-bit executable arm64",
        dylib: "Mach-O 64-bit dynamically linked shared library arm64",
        text_file: "ASCII text",
    }
    commands: list[list[str]] = []

    signed = sign_macos_backend.sign_macho_files(
        backend_dir,
        "Developer ID Application: Example (TEAMID)",
        describe=descriptions.__getitem__,
        run=lambda command: commands.append(list(command)),
    )

    assert signed == [dylib, playwright_node]
    sign_commands = [command for command in commands if "--sign" in command]
    verify_commands = [command for command in commands if "--verify" in command]
    assert [Path(command[-1]) for command in sign_commands] == signed
    assert [Path(command[-1]) for command in verify_commands] == signed
    assert all("runtime" in command for command in sign_commands)


def test_rejects_a_bundle_without_macho_payloads(tmp_path: Path) -> None:
    backend_dir = tmp_path / "backend"
    backend_dir.mkdir()
    (backend_dir / "README").write_text("fixture")

    with pytest.raises(RuntimeError, match="no Mach-O files"):
        sign_macos_backend.sign_macho_files(
            backend_dir,
            "Developer ID Application: Example (TEAMID)",
            describe=lambda _path: "ASCII text",
            run=lambda _command: None,
        )
