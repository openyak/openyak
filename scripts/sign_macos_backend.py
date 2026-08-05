"""Sign every Mach-O payload embedded in the frozen macOS backend bundle."""

from __future__ import annotations

import argparse
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path


DescribeFile = Callable[[Path], str]
RunCommand = Callable[[Sequence[str]], None]


def describe_file(path: Path) -> str:
    result = subprocess.run(
        ["file", "--brief", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def discover_macho_files(
    backend_dir: Path,
    *,
    describe: DescribeFile = describe_file,
) -> list[Path]:
    if not backend_dir.is_dir():
        raise ValueError(f"backend bundle does not exist: {backend_dir}")

    macho_files: list[Path] = []
    for candidate in sorted(backend_dir.rglob("*")):
        if candidate.is_symlink() or not candidate.is_file():
            continue
        if describe(candidate).startswith("Mach-O"):
            macho_files.append(candidate)
    return macho_files


def run_command(command: Sequence[str]) -> None:
    subprocess.run(command, check=True)


def sign_macho_files(
    backend_dir: Path,
    identity: str,
    *,
    describe: DescribeFile = describe_file,
    run: RunCommand = run_command,
) -> list[Path]:
    if not identity.strip():
        raise ValueError("a non-empty Developer ID signing identity is required")

    macho_files = discover_macho_files(backend_dir, describe=describe)
    if not macho_files:
        raise RuntimeError(f"no Mach-O files found in backend bundle: {backend_dir}")

    for path in macho_files:
        run(
            [
                "codesign",
                "--force",
                "--options",
                "runtime",
                "--timestamp",
                "--sign",
                identity,
                str(path),
            ]
        )
        run(["codesign", "--verify", "--strict", str(path)])
    return macho_files


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backend_dir", type=Path)
    parser.add_argument("--identity", required=True)
    args = parser.parse_args()

    signed = sign_macho_files(args.backend_dir, args.identity)
    print(f"Signed and verified {len(signed)} Mach-O files")


if __name__ == "__main__":
    main()
