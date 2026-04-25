"""Tests for local session-token generation."""

from __future__ import annotations

import json

import pytest

from app.auth.token import ensure_session_token


def test_ensure_session_token_accepts_dev_override(tmp_path):
    token_path = tmp_path / "session_token.json"
    token = "openyak_st_test_dev_override"

    generated = ensure_session_token(token_path, token=token)

    assert generated == token
    assert json.loads(token_path.read_text(encoding="utf-8")) == {"token": token}


def test_ensure_session_token_rejects_non_session_override(tmp_path):
    with pytest.raises(ValueError, match="openyak_st_"):
        ensure_session_token(tmp_path / "session_token.json", token="openyak_rt_wrong")
