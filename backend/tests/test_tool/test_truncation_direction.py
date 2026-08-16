"""Oversized output must keep the part that says what happened.

`bash` and `code_execute` truncate from the head so the tail — where a failing
run reports its error — survives. That only works if the exit status is at the
tail too; as a header it was the first thing dropped, and `result.error` does
not compensate because `_build_tool_persist_output` prefers `output` whenever
it is non-empty.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.tool.builtin.bash import BashTool
from app.tool.truncation import MAX_LINES, truncate_output


def _ctx(tmp_path):
    return SimpleNamespace(
        agent=SimpleNamespace(tools=[]),
        workspace=str(tmp_path),
        abort_event=asyncio.Event(),
        is_aborted=False,
    )


@pytest.mark.parametrize("tool_cls", [BashTool])
def test_the_failing_tools_truncate_from_the_tail(tool_cls) -> None:
    assert tool_cls().truncation_direction == "tail"


async def test_a_failing_command_with_huge_output_still_reports_its_exit_code(
    tmp_path,
) -> None:
    """The model must not be told a failed command succeeded."""
    tool = BashTool()
    # Pure shell: the test host is not guaranteed a `python` on PATH.
    noisy_failure = f"yes noise | head -n {MAX_LINES * 2}; exit 3"

    result = await tool(
        {"command": noisy_failure, "timeout": 60}, _ctx(tmp_path)
    )

    body = result.output or ""
    assert len(body.splitlines()) < MAX_LINES * 2, "the output should have been truncated"
    assert "Exit code: 3" in body, (
        "tail truncation dropped the exit status, so the model sees only the "
        "'tool call succeeded' hint for a command that failed"
    )


def test_tail_truncation_keeps_the_end_and_head_keeps_the_start() -> None:
    """Pin the property the direction flag exists for."""
    text = "\n".join(f"line{i}" for i in range(MAX_LINES * 2))

    tail = truncate_output(text, direction="tail")
    head = truncate_output(text, direction="head")

    assert tail.truncated and head.truncated
    assert text.splitlines()[-1] in tail.content
    assert text.splitlines()[0] in head.content
