"""Tests for app.tool.subprocess_compat."""

from __future__ import annotations

import pytest

from app.tool.subprocess_compat import (
    IS_WINDOWS,
    decode_subprocess_output,
    find_shell,
    get_subprocess_kwargs,
)


class TestGetSubprocessKwargs:
    def test_returns_dict(self):
        result = get_subprocess_kwargs()
        assert isinstance(result, dict)

    @pytest.mark.skipif(not IS_WINDOWS, reason="Windows-only")
    def test_windows_has_creationflags(self):
        kwargs = get_subprocess_kwargs()
        assert "creationflags" in kwargs

    @pytest.mark.skipif(IS_WINDOWS, reason="Non-Windows only")
    def test_non_windows_no_creationflags(self):
        kwargs = get_subprocess_kwargs()
        assert "creationflags" not in kwargs


class TestDecodeSubprocessOutput:
    def test_utf8_bytes(self):
        assert decode_subprocess_output(b"hello") == "hello"

    def test_utf8_unicode(self):
        text = "你好世界"
        assert decode_subprocess_output(text.encode("utf-8")) == text

    def test_empty_bytes(self):
        assert decode_subprocess_output(b"") == ""

    def test_invalid_bytes_replaced(self):
        # Invalid UTF-8 sequence — should not raise, returns a string
        result = decode_subprocess_output(b"\xff\xfe")
        assert isinstance(result, str)


class TestFindShell:
    def test_returns_list(self):
        result = find_shell()
        assert isinstance(result, list)
        assert len(result) >= 2

    @pytest.mark.skipif(not IS_WINDOWS, reason="Windows-only")
    def test_windows_uses_powershell(self):
        result = find_shell()
        assert result[0] == "powershell.exe"

    @pytest.mark.skipif(IS_WINDOWS, reason="Non-Windows only")
    def test_non_windows_uses_bash_or_sh(self):
        result = find_shell()
        assert "bash" in result[0] or "sh" in result[0]
