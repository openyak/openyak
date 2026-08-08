"""Bash tool tests."""

import sys
from pathlib import Path

import pytest

from app.schemas.agent import AgentInfo
from app.tool.builtin.bash import BashTool
from app.tool.context import ToolContext
from app.tool.subprocess_compat import IS_WINDOWS


def _make_ctx(workspace: str | None = None) -> ToolContext:
    return ToolContext(
        session_id="test-session",
        message_id="test-msg",
        agent=AgentInfo(name="test", description="", mode="primary"),
        call_id="test-call",
        workspace=workspace,
    )


class TestBashTool:
    @pytest.fixture
    def tool(self):
        return BashTool()

    @pytest.mark.asyncio
    async def test_echo(self, tool: BashTool):
        result = await tool.execute({"command": "echo hello"}, _make_ctx())
        assert "hello" in result.output

    @pytest.mark.asyncio
    async def test_exit_code_nonzero(self, tool: BashTool):
        if IS_WINDOWS:
            # PowerShell: exit 1
            result = await tool.execute({"command": "exit 1"}, _make_ctx())
        else:
            result = await tool.execute({"command": "exit 1"}, _make_ctx())
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_timeout(self, tool: BashTool):
        if IS_WINDOWS:
            cmd = "Start-Sleep -Seconds 10"
        else:
            cmd = "sleep 10"
        result = await tool.execute({"command": cmd, "timeout": 1}, _make_ctx())
        assert "timed out" in (result.error or "").lower()

    @pytest.mark.asyncio
    async def test_captures_stderr(self, tool: BashTool):
        if IS_WINDOWS:
            result = await tool.execute({"command": "Write-Error 'err' 2>&1"}, _make_ctx())
        else:
            result = await tool.execute({"command": "echo err >&2"}, _make_ctx())
        assert "err" in result.output

    @pytest.mark.asyncio
    async def test_unicode_output(self, tool: BashTool, tmp_path: Path):
        """Non-ASCII output should not be garbled.

        Runs the interpreter under test rather than a bare ``python3``: Windows
        ships a ``python3`` alias that resolves to a Microsoft Store stub, so
        the command failed there and the assertion never exercised decoding.
        The payload is non-ASCII so the test earns its name.
        """
        expected = "héllo wörld 中文"
        script = tmp_path / "emit_unicode.py"
        script.write_text(
            "import sys\n"
            "sys.stdout.reconfigure(encoding='utf-8')\n"
            f"print({expected!r})\n",
            encoding="utf-8",
        )
        # PowerShell needs the call operator for a quoted executable path.
        prefix = "& " if IS_WINDOWS else ""
        result = await tool.execute(
            {"command": f'{prefix}"{sys.executable}" "{script}"'}, _make_ctx()
        )

        assert result.error is None, result.output
        assert expected in result.output

    @pytest.mark.asyncio
    async def test_reports_workspace_root_without_exposing_its_path(
        self,
        tool: BashTool,
        tmp_path: Path,
    ):
        result = await tool.execute(
            {"command": "echo ok", "cwd": str(tmp_path)},
            _make_ctx(str(tmp_path)),
        )

        assert result.success
        assert result.metadata["cwd_scope"] == "workspace_root"
        assert str(tmp_path) not in result.metadata.values()
