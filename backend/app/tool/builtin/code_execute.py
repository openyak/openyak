"""Code execution tool — run Python code in-process.

Executes Python code in a background thread using the backend's own
interpreter. All packages bundled with the backend (pandas, numpy,
matplotlib, etc.) are available without requiring a separate Python
installation.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import traceback
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from typing import Any, Literal

from app.tool.base import ToolDefinition, ToolResult
from app.tool.context import ToolContext

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30  # seconds
MAX_TIMEOUT = 120
MAX_OUTPUT = 51200  # 50 KB


def _snapshot_workspace(workspace: str | None) -> dict[str, tuple[int, int]]:
    """Return a cheap file snapshot for detecting created/modified files."""
    root = Path(workspace).resolve() if workspace else Path.cwd().resolve()
    if not root.is_dir():
        return {}

    snapshot: dict[str, tuple[int, int]] = {}
    try:
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            # mtime_ns + size is enough for UI/session tracking purposes
            snapshot[str(path.resolve())] = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return {}

    return snapshot


class CodeExecuteTool(ToolDefinition):

    @property
    def id(self) -> str:
        return "code_execute"

    @property
    def truncation_direction(self) -> Literal["head", "tail"]:
        """Keep the end: a failed run reports why on its last lines."""
        return "tail"

    @property
    def description(self) -> str:
        return (
            "Execute Python code. "
            "The code runs with the backend's Python environment so pandas, "
            "numpy, matplotlib and other installed packages are available. "
            "IMPORTANT: Each call runs in a fresh, isolated namespace — no state "
            "(variables, imports, data) persists between calls. You MUST include "
            "all imports and data loading in every call. For multi-step analysis, "
            "put ALL code in a single call rather than splitting across multiple calls. "
            "When a workspace is active, the namespace includes the absolute string "
            "paths OPENYAK_WORKSPACE and OPENYAK_OUTPUT_DIR. These are Python "
            "variables, not environment variables: use "
            "Path(OPENYAK_OUTPUT_DIR) / 'file.ext'. Write user-requested artifacts "
            "under OPENYAK_OUTPUT_DIR."
        )

    def parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python code to execute",
                },
                "timeout": {
                    "type": "integer",
                    "description": f"Timeout in seconds (default {DEFAULT_TIMEOUT}, max {MAX_TIMEOUT})",
                    "default": DEFAULT_TIMEOUT,
                },
            },
            "required": ["code"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        code = args.get("code", "")
        if not code.strip():
            return ToolResult(error="No code provided")

        timeout = min(args.get("timeout", DEFAULT_TIMEOUT), MAX_TIMEOUT)
        before_snapshot = _snapshot_workspace(ctx.workspace)
        workspace_path = (
            Path(ctx.workspace).resolve() if ctx.workspace else Path.cwd().resolve()
        )
        output_path = (
            workspace_path / "openyak_written" if ctx.workspace else workspace_path
        )
        output_path.mkdir(parents=True, exist_ok=True)

        try:
            output, exit_code = await asyncio.wait_for(
                asyncio.to_thread(
                    _run_code,
                    code,
                    str(workspace_path),
                    str(output_path),
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            return ToolResult(
                error=f"Execution timed out after {timeout}s",
                metadata={"timeout": True},
            )
        except Exception as exc:
            return ToolResult(error=f"Execution failed: {exc}")

        title = f"python: {code[:60]}..." if len(code) > 60 else f"python: {code}"
        after_snapshot = _snapshot_workspace(ctx.workspace)
        written_files = sorted(
            path
            for path, sig in after_snapshot.items()
            if before_snapshot.get(path) != sig
        )

        return ToolResult(
            output=output,
            title=title,
            metadata={
                "exit_code": exit_code,
                "language": "python",
                "written_files": written_files,
            },
            error=f"Code execution failed with exit code {exit_code}" if exit_code != 0 else None,
        )


def _run_code(
    code: str,
    workspace_path: str,
    output_path: str,
) -> tuple[str, int]:
    """Execute *code* in an isolated namespace and return (output, exit_code)."""
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    exit_code = 0

    # Fresh namespace so each call is isolated.
    namespace: dict[str, Any] = {
        "__builtins__": __builtins__,
        "OPENYAK_WORKSPACE": workspace_path,
        "OPENYAK_OUTPUT_DIR": output_path,
    }

    # Save/restore cwd so user code can't permanently change it.
    original_cwd = os.getcwd()

    try:
        compiled = compile(code, "<code_execute>", "exec")
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(compiled, namespace)
    except SystemExit as e:
        # Allow sys.exit() — treat the exit code as the return code.
        exit_code = e.code if isinstance(e.code, int) else 1
    except Exception:
        traceback.print_exc(file=stderr_buf)
        exit_code = 1
    finally:
        try:
            os.chdir(original_cwd)
        except OSError:
            pass

    stdout = stdout_buf.getvalue()[:MAX_OUTPUT]
    stderr = stderr_buf.getvalue()[:MAX_OUTPUT]

    parts: list[str] = []
    if stdout:
        parts.append(stdout)
    if stderr:
        parts.append(f"STDERR:\n{stderr}")

    output = "\n".join(parts) if parts else "(no output)"
    if exit_code != 0:
        output = f"Exit code: {exit_code}\n{output}"

    return output, exit_code
