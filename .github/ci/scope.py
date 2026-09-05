"""Select v2 checks without leaving path-filtered required checks pending."""

import os
from pathlib import Path
import subprocess
import tomllib


def needs_checks(paths):
    roots = ("app/", "core/", ".github/workflows/", ".github/ci/", ".cargo/")
    inputs = {"package.json", "package-lock.json", "mise.toml", ".npmrc",
              "rust-toolchain", "rust-toolchain.toml"}
    return any(path.startswith(roots) or path in inputs for path in paths)


def main():
    event, base, head = (os.environ.get(key, "") for key in ("EVENT", "BASE", "HEAD"))
    # Manual runs and initial pushes intentionally exercise everything.
    if event == "workflow_dispatch" or not base or set(base) == {"0"}:
        selected = True
    elif subprocess.run(["git", "cat-file", "-e", f"{base}^{{commit}}"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        # A force-push may remove the old base from the fetched history. Running
        # all checks is safe; guessing that nothing changed would not be.
        selected = True
    else:
        # Disable rename detection: moving a source file out of app/core must
        # still count as a deletion there. NUL splitting handles unusual names.
        revision = f"{base}...{head}" if event == "pull_request" else f"{base}..{head}"
        changed = subprocess.check_output(
            ["git", "diff", "--no-renames", "--name-only", "-z", revision]
        ).decode().split("\0")
        selected = needs_checks(changed)
    versions = tomllib.loads(Path("mise.toml").read_text())["tools"]
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"code={str(selected).lower()}\n")
        for name in ("node", "rust"):
            version = versions[name]
            if not isinstance(version, str) or len(version.split(".")) != 3 or not all(part.isdigit() for part in version.split(".")):
                raise ValueError(f"Expected a pinned numeric {name} version in mise.toml")
            output.write(f"{name}={version}\n")
    print(f"V2 runtime checks: {selected}; toolchains: {versions}")


if __name__ == "__main__":
    main()
