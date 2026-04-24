"""Shared test fixtures."""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.agent import AgentRegistry
from app.config import Settings
from app.models.base import Base
from app.provider.openrouter import OpenRouterProvider
from app.provider.registry import ProviderRegistry
from app.tool.registry import ToolRegistry


# ---------------------------------------------------------------------------
# Event loop
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def settings() -> Settings:
    """Load settings from .env (includes the real API key)."""
    return Settings(_env_file=str(Path(__file__).parent.parent / ".env"))


@pytest.fixture(scope="session")
def api_key(settings: Settings) -> str:
    key = settings.openrouter_api_key
    if not key:
        pytest.skip("OPENYAK_OPENROUTER_API_KEY not set")
    return key


# ---------------------------------------------------------------------------
# Database (in-memory SQLite per test function)
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def db_engine():
    engine = create_async_engine("sqlite+aiosqlite://", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def session_factory(db_engine):
    return async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def db(session_factory):
    async with session_factory() as session:
        async with session.begin():
            yield session


# ---------------------------------------------------------------------------
# Registries
# ---------------------------------------------------------------------------

@pytest.fixture
def agent_registry() -> AgentRegistry:
    return AgentRegistry()


@pytest.fixture
def tool_registry() -> ToolRegistry:
    from app.main import _register_builtin_tools
    tr = ToolRegistry()
    _register_builtin_tools(tr)
    return tr


@pytest_asyncio.fixture
async def provider_registry(api_key: str) -> ProviderRegistry:
    """Real ProviderRegistry with OpenRouter (needs API key)."""
    registry = ProviderRegistry()
    provider = OpenRouterProvider(api_key)
    registry.register(provider)
    await registry.refresh_models()
    return registry


# ---------------------------------------------------------------------------
# Temp directory for file tool tests
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_dir(tmp_path: Path) -> Path:
    """Provide a temp directory for file-based tool tests."""
    return tmp_path


# ---------------------------------------------------------------------------
# FastAPI test client (for API endpoint tests)
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def app_client(db_engine, session_factory):
    """Async HTTP client wired to the FastAPI app with a test database."""
    import httpx
    from unittest.mock import AsyncMock, MagicMock
    from app.main import create_app
    from app.config import Settings
    from app.dependencies import (
        get_db,
        get_provider_registry,
        get_settings,
        get_agent_registry,
        get_tool_registry,
        get_skill_registry,
        get_session_factory,
        get_stream_manager,
        set_session_factory,
        set_settings,
        set_provider_registry,
        set_agent_registry,
        set_tool_registry,
        set_skill_registry,
    )

    settings = Settings(
        openrouter_api_key="test-key",
        database_url="sqlite+aiosqlite://",
    )
    app = create_app(settings)

    # Wire up test DB via dependency override
    async def _override_get_db():
        async with session_factory() as session:
            async with session.begin():
                yield session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.session_factory = session_factory
    app.state.engine = db_engine

    # Mock external registries
    mock_pr = MagicMock()
    mock_pr.all_models.return_value = []
    mock_pr.refresh_models = AsyncMock(return_value={})
    mock_pr.resolve_model.return_value = None
    mock_pr.health = AsyncMock(return_value={})
    app.state.provider_registry = mock_pr

    mock_ar = MagicMock()
    mock_tr = MagicMock()
    mock_sr = MagicMock()

    app.state.agent_registry = mock_ar
    app.state.tool_registry = mock_tr
    app.state.skill_registry = mock_sr
    app.state.connector_registry = None
    app.state.plugin_manager = None
    app.state.stream_manager = None
    app.state.settings = settings
    # AuthMiddleware requires a session token on app.state; in production
    # it is generated by lifespan startup, but create_app() does not run
    # the lifespan, so we seed a deterministic test token here and have
    # the client inject it on every request below.
    app.state.session_token = "test-session-token"

    # Also set module-level DI globals so Depends() resolves correctly
    set_session_factory(session_factory)
    set_settings(settings)
    set_provider_registry(mock_pr)
    set_agent_registry(mock_ar)
    set_tool_registry(mock_tr)
    set_skill_registry(mock_sr)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        # Inject the deterministic session bearer token on every request so
        # existing API tests that pre-date mandatory auth keep working
        # without per-test boilerplate. Tests that specifically exercise
        # auth (e.g. test_auth_middleware.py) build their own client.
        headers={"Authorization": "Bearer test-session-token"},
    ) as client:
        client.app = app  # expose for tests that need to tweak app.state
        yield client
