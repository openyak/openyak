"""Per-session model memory — the session row remembers its last-used model.

Covers the storage + serialization half of the feature: the ``model_id`` /
``provider_id`` columns persist and round-trip through ``SessionResponse``.
The write itself happens in ``app/session/prompt.py`` ``_setup`` on every prompt.
"""

from __future__ import annotations

import pytest

from app.schemas.session import SessionResponse
from app.session.manager import create_session, get_session

pytestmark = pytest.mark.asyncio


async def test_session_persists_last_used_model(session_factory):
    """Setting model_id/provider_id on a session survives a reload in a fresh
    DB session (proves it hit the DB, not just the identity map)."""
    async with session_factory() as db:
        async with db.begin():
            session = await create_session(db, directory=".")
            # Mirror what prompt._setup does after resolving the model.
            session.model_id = "claude-sonnet-4-20250514"
            session.provider_id = "anthropic"
            session_id = session.id

    async with session_factory() as db:
        reloaded = await get_session(db, session_id)
        assert reloaded is not None
        assert reloaded.model_id == "claude-sonnet-4-20250514"
        assert reloaded.provider_id == "anthropic"

        dto = SessionResponse.model_validate(reloaded)
        assert dto.model_id == "claude-sonnet-4-20250514"
        assert dto.provider_id == "anthropic"


async def test_session_model_defaults_null(session_factory):
    """A fresh session with no prompt yet has no remembered model — the
    frontend falls back to the global default in that case."""
    async with session_factory() as db:
        async with db.begin():
            session = await create_session(db, directory=".")
            session_id = session.id

    async with session_factory() as db:
        reloaded = await get_session(db, session_id)
        assert reloaded is not None
        assert reloaded.model_id is None
        assert reloaded.provider_id is None

        dto = SessionResponse.model_validate(reloaded)
        assert dto.model_id is None
        assert dto.provider_id is None


async def test_last_used_model_overwrites_on_change(session_factory):
    """Switching models mid-session updates the remembered model to the latest."""
    async with session_factory() as db:
        async with db.begin():
            session = await create_session(db, directory=".")
            session.model_id = "claude-sonnet-4-20250514"
            session.provider_id = "anthropic"
            session_id = session.id

    # A later prompt with a different model overwrites it.
    async with session_factory() as db:
        async with db.begin():
            session = await get_session(db, session_id)
            session.model_id = "gpt-5.5"
            session.provider_id = "openai-subscription"

    async with session_factory() as db:
        reloaded = await get_session(db, session_id)
        assert reloaded.model_id == "gpt-5.5"
        assert reloaded.provider_id == "openai-subscription"
