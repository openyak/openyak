"""FastAPI dependency injection.

Provides typed ``Depends()`` callables and ``Annotated`` aliases for all
application singletons.  Each singleton follows the same pattern:

1. A module-level ``_xxx`` variable initialised to ``None``.
2. A ``set_xxx()`` called once during lifespan startup.
3. A ``get_xxx()`` used as ``Depends(get_xxx)`` in route handlers.

Using ``Annotated`` aliases (e.g. ``ProviderRegistryDep``) keeps endpoint
signatures concise while remaining fully type-safe.
"""

from typing import Annotated, AsyncGenerator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# Import types directly (not behind TYPE_CHECKING) so Annotated aliases
# resolve correctly at runtime — required for FastAPI Depends().
from app.agent.agent import AgentRegistry
from app.config import Settings
from app.connector.registry import ConnectorRegistry
from app.fts.index import IndexManager
from app.plugin.manager import PluginManager
from app.provider.registry import ProviderRegistry
from app.skill.registry import SkillRegistry
from app.streaming.manager import StreamManager
from app.tool.registry import ToolRegistry

# ---------------------------------------------------------------------------
# Database session
# ---------------------------------------------------------------------------

_session_factory: async_sessionmaker[AsyncSession] | None = None


def set_session_factory(factory: async_sessionmaker[AsyncSession]) -> None:
    global _session_factory
    _session_factory = factory


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Return the session factory for direct use (not a context manager)."""
    if _session_factory is None:
        raise RuntimeError("Database not initialized")
    return _session_factory


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield a transactional async DB session."""
    if _session_factory is None:
        raise RuntimeError("Database not initialized")
    async with _session_factory() as session:
        async with session.begin():
            yield session


SessionFactoryDep = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
DbDep = Annotated[AsyncSession, Depends(get_db)]

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

_settings: Settings | None = None


def set_settings(s: Settings) -> None:
    global _settings
    _settings = s


def get_settings() -> Settings:
    if _settings is None:
        raise RuntimeError("Settings not initialized")
    return _settings


SettingsDep = Annotated[Settings, Depends(get_settings)]

# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

_provider_registry: ProviderRegistry | None = None


def set_provider_registry(r: ProviderRegistry) -> None:
    global _provider_registry
    _provider_registry = r


def get_provider_registry() -> ProviderRegistry:
    if _provider_registry is None:
        raise RuntimeError("ProviderRegistry not initialized")
    return _provider_registry


ProviderRegistryDep = Annotated[ProviderRegistry, Depends(get_provider_registry)]

# ---------------------------------------------------------------------------
# Agent registry
# ---------------------------------------------------------------------------

_agent_registry: AgentRegistry | None = None


def set_agent_registry(r: AgentRegistry) -> None:
    global _agent_registry
    _agent_registry = r


def get_agent_registry() -> AgentRegistry:
    if _agent_registry is None:
        raise RuntimeError("AgentRegistry not initialized")
    return _agent_registry


AgentRegistryDep = Annotated[AgentRegistry, Depends(get_agent_registry)]

# ---------------------------------------------------------------------------
# Skill registry
# ---------------------------------------------------------------------------

_skill_registry: SkillRegistry | None = None


def set_skill_registry(r: SkillRegistry) -> None:
    global _skill_registry
    _skill_registry = r


def get_skill_registry() -> SkillRegistry:
    if _skill_registry is None:
        raise RuntimeError("SkillRegistry not initialized")
    return _skill_registry


SkillRegistryDep = Annotated[SkillRegistry, Depends(get_skill_registry)]

# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

_tool_registry: ToolRegistry | None = None


def set_tool_registry(r: ToolRegistry) -> None:
    global _tool_registry
    _tool_registry = r


def get_tool_registry() -> ToolRegistry:
    if _tool_registry is None:
        raise RuntimeError("ToolRegistry not initialized")
    return _tool_registry


ToolRegistryDep = Annotated[ToolRegistry, Depends(get_tool_registry)]

# ---------------------------------------------------------------------------
# Stream manager (lazy — created on first use)
# ---------------------------------------------------------------------------

_stream_manager: StreamManager | None = None


def set_stream_manager(sm: StreamManager) -> None:
    global _stream_manager
    _stream_manager = sm


def get_stream_manager() -> StreamManager:
    """Get or create the StreamManager singleton."""
    global _stream_manager
    if _stream_manager is None:
        from app.streaming.manager import StreamManager as _SM
        _stream_manager = _SM()
    return _stream_manager


StreamManagerDep = Annotated[StreamManager, Depends(get_stream_manager)]

# ---------------------------------------------------------------------------
# Connector registry
# ---------------------------------------------------------------------------

_connector_registry: ConnectorRegistry | None = None


def set_connector_registry(r: ConnectorRegistry) -> None:
    global _connector_registry
    _connector_registry = r


def get_connector_registry() -> ConnectorRegistry:
    if _connector_registry is None:
        raise RuntimeError("ConnectorRegistry not initialized")
    return _connector_registry


ConnectorRegistryDep = Annotated[ConnectorRegistry, Depends(get_connector_registry)]

# ---------------------------------------------------------------------------
# Plugin manager
# ---------------------------------------------------------------------------

_plugin_manager: PluginManager | None = None


def set_plugin_manager(pm: PluginManager) -> None:
    global _plugin_manager
    _plugin_manager = pm


def get_plugin_manager() -> PluginManager:
    if _plugin_manager is None:
        raise RuntimeError("PluginManager not initialized")
    return _plugin_manager


PluginManagerDep = Annotated[PluginManager, Depends(get_plugin_manager)]

# ---------------------------------------------------------------------------
# FTS index manager (optional — may be None when FTS is disabled)
# ---------------------------------------------------------------------------

_index_manager: IndexManager | None = None


def set_index_manager(im: IndexManager) -> None:
    global _index_manager
    _index_manager = im


def get_index_manager() -> IndexManager | None:
    """Returns None when FTS is disabled."""
    return _index_manager


IndexManagerDep = Annotated[IndexManager | None, Depends(get_index_manager)]
