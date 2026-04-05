"""FastAPI application factory and lifespan."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import httpx

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.api.openai_compat import router as openai_compat_router
from app.api.router import api_router
from app.auth.middleware import RemoteAuthMiddleware
from app.config import Settings
from app.dependencies import (
    set_agent_registry,
    set_connector_registry,
    set_index_manager,
    set_plugin_manager,
    set_provider_registry,
    set_session_factory,
    set_settings,
    set_skill_registry,
    set_stream_manager,
    set_tool_registry,
)
from app.models.base import Base
from app.agent.agent import AgentRegistry
from app.provider.openrouter import OpenRouterProvider
from app.provider.local import create_local_provider
from app.provider.registry import ProviderRegistry
from app.skill.registry import SkillRegistry
from app.storage.database import create_engine, create_session_factory
from app.tool.registry import ToolRegistry

logger = logging.getLogger(__name__)



def _asyncio_exception_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
    """Custom handler for unhandled asyncio exceptions.

    Prevents silent swallowing of errors from fire-and-forget coroutines.
    """
    exc = context.get("exception")
    msg = context.get("message", "Unhandled asyncio exception")
    if exc:
        logger.error("%s: %s", msg, exc, exc_info=exc)
    else:
        logger.error("%s: %s", msg, context)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: startup and shutdown."""
    settings: Settings = app.state.settings

    # --- Startup ---

    # Configure app-level logging so logger.info() from app modules is visible
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s:     %(name)s - %(message)s",
    )

    # Install global asyncio exception handler
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(_asyncio_exception_handler)

    # Database
    engine = create_engine(settings)
    session_factory = create_session_factory(engine)
    set_session_factory(session_factory)

    # Ensure all models are registered with Base.metadata before create_all
    from app.memory import workspace_memory_model as _ws_memory_models  # noqa: F401 — registers WorkspaceMemory

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Add any missing columns to existing tables (lightweight auto-migration)
        await conn.run_sync(_add_missing_columns)

    app.state.engine = engine
    app.state.session_factory = session_factory

    # Provider registry
    registry = ProviderRegistry()

    # If OpenYak proxy is configured, register it as "openyak-proxy" (billing mode).
    # This is separate from the user's own OpenRouter key.
    if settings.proxy_url and settings.proxy_token:
        proxy_provider = OpenRouterProvider(
            settings.proxy_token,
            base_url=settings.proxy_url + "/v1",
            provider_id="openyak-proxy",
        )
        registry.register(proxy_provider)
        try:
            await registry.refresh_models()
        except Exception as e:
            logger.warning("Failed to load models from proxy on startup: %s", e)
            if settings.proxy_refresh_token:
                from app.provider.proxy_auth import refresh_proxy_token
                if await refresh_proxy_token(settings, registry):
                    try:
                        await registry.refresh_models()
                    except Exception as e2:
                        logger.warning("Still failed after token refresh: %s", e2)

    # Register OpenAI subscription provider if configured
    if settings.openai_oauth_access_token and settings.openai_oauth_account_id:
        from app.provider.openai_subscription import OpenAISubscriptionProvider

        sub_provider = OpenAISubscriptionProvider(
            access_token=settings.openai_oauth_access_token,
            account_id=settings.openai_oauth_account_id,
            refresh_token=settings.openai_oauth_refresh_token,
            expires_at_ms=settings.openai_oauth_expires_at,
            settings=settings,
        )
        registry.register(sub_provider)
        logger.info("OpenAI subscription provider registered from saved tokens")

        # Proactively refresh token on startup if it's expired/expiring
        try:
            await sub_provider._ensure_valid_token()
        except Exception as e:
            logger.warning("Startup token refresh failed: %s — user may need to re-authorize", e)

        try:
            await registry.refresh_models()
        except Exception as e:
            logger.warning("Failed to refresh models after subscription provider registration: %s", e)

    # Ollama runtime manager (always created — manages binary + process)
    from app.ollama.manager import OllamaManager

    data_dir = Path.cwd()  # Desktop mode: run.py sets cwd to the data directory
    ollama_manager = OllamaManager(data_dir=data_dir)
    app.state.ollama_manager = ollama_manager

    # If Ollama URL is configured, register provider.
    # If the managed binary is installed and auto-start is on, start the process.
    if settings.ollama_base_url:
        from app.provider.ollama import OllamaProvider

        # Try to auto-start managed Ollama if binary exists
        if ollama_manager.is_binary_installed and settings.ollama_auto_start:
            try:
                base_url = await ollama_manager.start()
                ollama_provider = OllamaProvider(base_url=base_url)
                # Update settings in case port changed
                settings.ollama_base_url = base_url
            except Exception as e:
                logger.warning("Failed to auto-start managed Ollama: %s — trying configured URL", e)
                ollama_provider = OllamaProvider(base_url=settings.ollama_base_url)
        else:
            ollama_provider = OllamaProvider(base_url=settings.ollama_base_url)

        registry.register(ollama_provider)
        try:
            await registry.refresh_models()
        except Exception as e:
            logger.warning("Ollama connection failed on startup: %s — will retry on first request", e)

        # Pre-warm last-used model so the first chat request is fast
        last_model = settings.ollama_last_model
        if last_model:
            async def _warmup_model(base_url: str, model: str) -> None:
                try:
                    async with httpx.AsyncClient(timeout=120.0) as client:
                        await client.post(
                            f"{base_url}/api/generate",
                            json={"model": model, "prompt": "", "keep_alive": "10m"},
                        )
                    logger.info("Ollama: pre-warmed model %s", model)
                except Exception as exc:
                    logger.debug("Ollama warmup skipped for %s: %s", model, exc)

            asyncio.create_task(_warmup_model(ollama_provider._base_url, last_model))

    # Pre-fetch models.dev catalog (remote model metadata: pricing, capabilities)
    from app.provider.models_dev import models_dev
    try:
        await models_dev.refresh()
    except Exception as e:
        logger.warning("models.dev pre-fetch failed: %s — will use cached/hardcoded data", e)

    # Schedule hourly background refresh
    async def _models_dev_refresh_loop() -> None:
        import asyncio
        while True:
            await asyncio.sleep(3600)
            try:
                await models_dev.refresh()
            except Exception:
                pass

    asyncio.create_task(_models_dev_refresh_loop())

    # Auto-register BYOK providers (OpenAI, Anthropic, Gemini, Groq, etc.)
    from app.provider.catalog import PROVIDER_CATALOG
    from app.provider.factory import create_provider as create_desktop_provider

    disabled = {s.strip() for s in settings.disabled_providers.split(",") if s.strip()}

    byok_registered = 0
    should_refresh_models = False
    for pid, pdef in PROVIDER_CATALOG.items():
        if pid in disabled:
            continue
        api_key = getattr(settings, pdef.settings_key, "")
        if not api_key:
            continue
        try:
            # Azure needs a user-provided base_url
            extra_kwargs: dict[str, str] = {}
            if pdef.kind == "openai_compat_azure":
                azure_url = getattr(settings, "azure_openai_base_url", "")
                if not azure_url:
                    logger.warning("Azure API key set but OPENYAK_AZURE_OPENAI_BASE_URL is missing — skipping")
                    continue
                extra_kwargs["base_url"] = azure_url

            provider = create_desktop_provider(pid, api_key, **extra_kwargs)
            registry.register(provider)
            byok_registered += 1
            should_refresh_models = True
            logger.info("Registered BYOK provider: %s", pid)
        except Exception as e:
            logger.warning("Failed to register provider %s: %s", pid, e)

    # Auto-register custom endpoints
    from app.config import get_custom_endpoints
    for ce in get_custom_endpoints(settings):
        if not ce.get("enabled", True):
            continue
        try:
            pid = ce["id"]
            if pid in disabled:
                continue
            provider = create_desktop_provider(pid, ce.get("api_key", ""), base_url=ce.get("base_url"))
            registry.register(provider)
            byok_registered += 1
            should_refresh_models = True
            logger.info("Registered custom provider: %s (%s)", pid, ce.get("name"))
        except Exception as e:
            logger.warning("Failed to register custom provider %s: %s", ce.get("id"), e)

    if settings.local_base_url:
        try:
            local_provider = create_local_provider(settings.local_base_url)
            registry.register(local_provider)
            should_refresh_models = True
            logger.info("Registered local provider at %s", settings.local_base_url)
        except Exception as e:
            logger.warning("Failed to register local provider %s: %s", settings.local_base_url, e)

    if should_refresh_models:
        try:
            await registry.refresh_models()
        except Exception as e:
            logger.warning("Model refresh failed after provider registration: %s", e)

    app.state.provider_registry = registry
    set_provider_registry(registry)

    # Agent registry (built-in + custom agents from config / .openyak/agents/*.md)
    agent_registry = AgentRegistry()
    agent_registry.load_custom_agents(settings.agents, settings.project_dir)
    app.state.agent_registry = agent_registry
    set_agent_registry(agent_registry)

    # Skill registry
    bundled_skills_dir = Path(__file__).parent / "data" / "skills"
    skill_registry = SkillRegistry(bundled_dir=bundled_skills_dir, project_dir=settings.project_dir)
    skill_registry.scan(project_dir=settings.project_dir)
    app.state.skill_registry = skill_registry
    set_skill_registry(skill_registry)

    # Connector registry (manages deduplicated MCP connections)
    from app.connector.registry import ConnectorRegistry

    connector_registry = ConnectorRegistry(project_dir=settings.project_dir)

    # Plugin loader (Claude knowledge-work-plugins → OpenYak registries)
    from app.plugin import load_plugins_by_source
    from app.plugin.manager import PluginManager

    plugin_manager = PluginManager(
        skill_registry=skill_registry,
        project_dir=settings.project_dir,
    )

    for source, plugin_result in load_plugins_by_source(settings.project_dir):
        # Register skills + agents into their registries
        for skill in plugin_result.skills:
            skill_registry.register(skill)
        for agent in plugin_result.agents:
            agent_registry.register(agent)
        for err in plugin_result.errors:
            logger.warning("Plugin: %s", err)

        # Extract connectors from plugins into ConnectorRegistry (dedup)
        connector_ids_by_plugin: dict[str, list[str]] = {}
        for plugin_name, mcp_servers in plugin_result.mcp_by_plugin.items():
            cids = connector_registry.register_from_plugin(plugin_name, mcp_servers)
            connector_ids_by_plugin[plugin_name] = cids

        # Track in plugin manager (handles disable state)
        plugin_manager.register_loaded(
            plugin_result, source, plugin_result.meta_map,
            connector_ids_by_plugin=connector_ids_by_plugin,
        )

    app.state.plugin_manager = plugin_manager
    set_plugin_manager(plugin_manager)
    if plugin_manager.status():
        logger.info("Plugin manager: %d plugins loaded", len(plugin_manager.status()))

    # Start connector connections (MCP servers)
    await connector_registry.startup()
    app.state.connector_registry = connector_registry
    set_connector_registry(connector_registry)
    # Backward compat: expose mcp_manager for any code that still uses it
    app.state.mcp_manager = connector_registry.mcp_manager

    # Tool registry (tools registered in Step 6)
    tool_registry = ToolRegistry()
    _register_builtin_tools(tool_registry, skill_registry=skill_registry, settings=settings)

    # Register MCP tools from connected connectors + bind for dynamic refresh
    connector_registry.set_tool_registry(tool_registry)
    for mcp_tool in connector_registry.tools():
        tool_registry.register(mcp_tool)
    if connector_registry.tools():
        logger.info("MCP integration enabled (%d tools)", len(connector_registry.tools()))

    app.state.tool_registry = tool_registry
    set_tool_registry(tool_registry)

    # Clean up stale tool output files (from truncation overflow, 7-day retention)
    from app.tool.truncation import cleanup_old_outputs
    cleanup_old_outputs(workspace=settings.project_dir)

    # Rebuild upload file hash index for dedup (run in thread to avoid blocking the event loop)
    from app.api.files import rebuild_hash_index
    await asyncio.to_thread(rebuild_hash_index)

    # Remote access tunnel (optional — only when enabled in settings)
    if settings.remote_access_enabled and settings.remote_tunnel_mode == "cloudflare":
        from app.auth.tunnel import TunnelManager

        tunnel_mgr = TunnelManager(backend_port=settings.port)
        try:
            tunnel_url = await tunnel_mgr.start()
            app.state.tunnel_manager = tunnel_mgr
            logger.info("Remote access tunnel: %s", tunnel_url)
        except Exception as e:
            logger.warning("Failed to start remote tunnel on startup: %s — remote access disabled", e)

    # Built-in FTS5 search (enabled by default)
    if settings.fts_enabled:
        from app.fts import IndexManager
        index_manager = IndexManager()
        app.state.index_manager = index_manager
        set_index_manager(index_manager)
        logger.info("FTS5 search enabled")

    # Task scheduler (cron + interval automations)
    from app.scheduler.engine import TaskScheduler
    task_scheduler = TaskScheduler(session_factory, app.state)
    await task_scheduler.start()
    app.state.task_scheduler = task_scheduler

    # OpenClaw runtime manager (always created — manages binary + process)
    from app.openclaw.manager import OpenClawManager

    openclaw_manager = OpenClawManager(data_dir=data_dir)
    app.state.openclaw_manager = openclaw_manager

    # Workspace memory queue (async, debounced refresh)
    from app.memory.workspace_memory_queue import (
        WorkspaceMemoryUpdateQueue,
        set_workspace_memory_queue,
    )
    from app.memory.config import get_memory_config as _get_mem_cfg

    _mem_cfg = _get_mem_cfg()
    ws_memory_queue = WorkspaceMemoryUpdateQueue(
        session_factory,
        registry,
        debounce_seconds=_mem_cfg.debounce_seconds,
    )
    set_workspace_memory_queue(ws_memory_queue)
    app.state.ws_memory_queue = ws_memory_queue

    yield

    # --- Shutdown ---

    # Graceful shutdown: abort active generation jobs and wait for them
    sm = getattr(app.state, "stream_manager", None)
    if sm is not None:
        aborted = sm.abort_all()
        if aborted:
            logger.info("Shutdown: aborted %d active generation job(s), waiting up to %.1fs", aborted, settings.shutdown_timeout)
            tasks = [
                j.task for j in sm._jobs.values()
                if j.task is not None and not j.task.done()
            ]
            if tasks:
                done, pending = await asyncio.wait(tasks, timeout=settings.shutdown_timeout)
                # Force-cancel any tasks that didn't finish in time
                for t in pending:
                    t.cancel()
                if pending:
                    logger.warning("Shutdown: force-cancelled %d lingering task(s)", len(pending))
                    await asyncio.gather(*pending, return_exceptions=True)

    # Stop OpenClaw runtime
    openclaw_mgr = getattr(app.state, "openclaw_manager", None)
    if openclaw_mgr and openclaw_mgr.is_running:
        await openclaw_mgr.stop()

    # Stop remote tunnel
    tunnel_mgr = getattr(app.state, "tunnel_manager", None)
    if tunnel_mgr:
        await tunnel_mgr.stop()

    if hasattr(app.state, "connector_registry"):
        await app.state.connector_registry.shutdown()

    if hasattr(app.state, "task_scheduler"):
        await app.state.task_scheduler.stop()

    if hasattr(app.state, "index_manager"):
        await app.state.index_manager.shutdown()

    # Stop managed Ollama process
    ollama_mgr = getattr(app.state, "ollama_manager", None)
    if ollama_mgr and ollama_mgr.is_running:
        await ollama_mgr.stop()

    await engine.dispose()


def _register_builtin_tools(
    registry: ToolRegistry,
    *,
    skill_registry: SkillRegistry | None = None,
    settings: Settings | None = None,
) -> None:
    """Register all built-in tools."""
    from app.tool.builtin.apply_patch import ApplyPatchTool
    from app.tool.builtin.artifact import ArtifactTool
    from app.tool.builtin.bash import BashTool
    from app.tool.builtin.code_execute import CodeExecuteTool
    from app.tool.builtin.edit import EditTool
    from app.tool.builtin.glob_tool import GlobTool
    from app.tool.builtin.grep import GrepTool
    from app.tool.builtin.invalid import InvalidTool
    from app.tool.builtin.plan import PlanTool
    from app.tool.builtin.question import QuestionTool
    from app.tool.builtin.submit_plan import SubmitPlanTool
    from app.tool.builtin.read import ReadTool
    from app.tool.builtin.skill import SkillTool
    from app.tool.builtin.task import TaskTool
    from app.tool.builtin.todo import TodoTool
    from app.tool.builtin.web_fetch import WebFetchTool
    from app.tool.builtin.web_search import WebSearchTool
    from app.tool.builtin.write import WriteTool

    for tool_cls in [
        ReadTool, WriteTool, EditTool, ApplyPatchTool,
        BashTool, CodeExecuteTool,
        GlobTool, GrepTool, QuestionTool, TodoTool,
        TaskTool, WebFetchTool, WebSearchTool, InvalidTool,
        PlanTool, SubmitPlanTool, ArtifactTool,
    ]:
        registry.register(tool_cls())

    # SkillTool needs the skill registry injected
    registry.register(SkillTool(skill_registry=skill_registry))

    if settings is not None and settings.fts_enabled:
        from app.tool.builtin.search import SearchTool
        registry.register(SearchTool())


def _add_missing_columns(connection) -> None:
    """Auto-migration: add columns that exist in models but not in the DB.

    SQLAlchemy's create_all only creates new tables — it won't alter existing
    ones. This function inspects each table and issues ALTER TABLE ADD COLUMN
    for any missing columns, using SQLite-compatible defaults.
    """
    from sqlalchemy import inspect as sa_inspect, text

    inspector = sa_inspect(connection)
    for table in Base.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue  # Table doesn't exist yet — create_all will handle it
        existing = {col["name"] for col in inspector.get_columns(table.name)}
        for col in table.columns:
            if col.name in existing:
                continue
            # Build ALTER TABLE statement with a sensible default
            col_type = col.type.compile(dialect=connection.dialect)
            default = ""
            if col.default is not None and col.default.is_scalar:
                val = col.default.arg
                if isinstance(val, str):
                    default = f" DEFAULT '{val}'"
                elif isinstance(val, bool):
                    default = f" DEFAULT {1 if val else 0}"
                elif isinstance(val, (int, float)):
                    default = f" DEFAULT {val}"
            elif col.nullable:
                default = " DEFAULT NULL"
            else:
                # NOT NULL column with no default — use a type-appropriate zero
                default = " DEFAULT ''" if "CHAR" in str(col_type).upper() or "TEXT" in str(col_type).upper() else " DEFAULT 0"
            sql = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col_type}{default}'
            logger.info("Auto-migration: %s", sql)
            connection.execute(text(sql))


def _find_frontend_dir() -> Path | None:
    """Locate the frontend static build (out/) directory.

    Searches common locations relative to the backend package.
    Returns None if not found (dev mode without static build).
    """
    candidates = [
        Path(__file__).parent.parent.parent / "frontend" / "out",  # monorepo: backend/../frontend/out
        Path(__file__).parent.parent / "frontend_out",  # bundled: backend/frontend_out
    ]
    for p in candidates:
        if p.is_dir() and (p / "index.html").exists():
            return p
    return None


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build and return the FastAPI application."""
    if settings is None:
        settings = Settings()

    app = FastAPI(
        title="OpenYak",
        version="0.0.1",
        lifespan=lifespan,
    )
    app.state.settings = settings
    set_settings(settings)

    # CORS — permissive for local dev, tighten in production
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )

    # Remote access auth — must be AFTER CORSMiddleware (inner middleware runs first)
    app.add_middleware(RemoteAuthMiddleware)

    # Mount routers
    app.include_router(health_router)
    app.include_router(api_router, prefix="/api")
    app.include_router(openai_compat_router, tags=["openai-compat"])

    # Serve frontend static files for remote access (phone browser).
    # In desktop mode, Tauri serves the frontend — this is only needed
    # when the phone accesses the backend directly via the tunnel.
    frontend_dir = _find_frontend_dir()
    if frontend_dir:
        from starlette.staticfiles import StaticFiles
        from starlette.responses import FileResponse

        # Mount _next/ static assets (JS, CSS, etc.)
        next_dir = frontend_dir / "_next"
        if next_dir.is_dir():
            app.mount("/_next", StaticFiles(directory=str(next_dir)), name="next-static")

        # Serve static files at root (favicon, manifest, etc.)
        @app.get("/favicon.svg")
        @app.get("/manifest.json")
        async def serve_root_static(request: Request):
            filename = request.url.path.lstrip("/")
            file_path = frontend_dir / filename
            if file_path.exists():
                return FileResponse(str(file_path))
            return FileResponse(str(frontend_dir / "404.html"), status_code=404)

        # SPA catch-all: serve the correct HTML for known routes.
        # Must be AFTER /api and /_next mounts to avoid conflicts.
        # Using StarletteRequest to prevent FastAPI from parsing query params.
        @app.get("/m")
        @app.get("/m/{rest:path}")
        async def serve_mobile_spa(request: Request):
            """Serve mobile PWA pages — SPA fallback to the appropriate HTML."""
            path = request.url.path.rstrip("/")
            # Try exact HTML file first (e.g. /m/settings → m/settings.html)
            html_file = frontend_dir / (path.lstrip("/") + ".html")
            if html_file.exists():
                return FileResponse(str(html_file))
            # Dynamic routes: /m/task/xxx → m/task/_.html (Next.js static export pattern)
            if "/task/" in path:
                task_html = frontend_dir / "m" / "task" / "_.html"
                if task_html.exists():
                    return FileResponse(str(task_html))
            # Fallback to /m index
            m_html = frontend_dir / "m.html"
            if m_html.exists():
                return FileResponse(str(m_html))
            return FileResponse(str(frontend_dir / "404.html"), status_code=404)

        logger.info("Frontend static files served from %s", frontend_dir)

    return app


# Default instance for `uvicorn app.main:app`
app = create_app()
