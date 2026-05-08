"""Application configuration via Pydantic Settings."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="OPENYAK_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Provider ---
    # Test-only: integration tests in backend/tests/ require a real OpenRouter
    # key for fixtures that exercise live model listings. Production code no
    # longer reads this — BYOK was removed in v2.0.0.
    openrouter_api_key: str = ""

    custom_endpoints: str = "[]"    # OPENYAK_CUSTOM_ENDPOINTS

    # Comma-separated list of provider IDs to disable (e.g. "custom_abc123").
    # Disabled providers are not registered even if their config is present.
    disabled_providers: str = ""  # OPENYAK_DISABLED_PROVIDERS

    # --- OpenYak Cloud Proxy (billing mode) ---
    proxy_url: str = ""  # e.g. "https://api.openyak.app" — when set, LLM calls go through proxy
    proxy_token: str = ""  # JWT from OpenYak account login
    proxy_refresh_token: str = ""  # Refresh token for auto-renewal

    # --- Database ---
    database_url: str = "sqlite+aiosqlite:///./data/openyak.db"

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False
    # Dev-only fixed session token. Used by npm run dev:all so the Next.js
    # dev server can authenticate browser-originated /api requests without
    # weakening backend auth. Ignored unless allow_dev_session_token=True.
    allow_dev_session_token: bool = False
    dev_session_token: str = ""

    # --- Project ---
    project_dir: str = "."

    # --- Web Search ---
    daily_search_limit: int = 20  # Max free web_search calls per day
    web_search_context_size: str = "low"  # "low" | "medium" | "high" — native search breadth (OpenAI subscription)
    max_native_searches_per_step: int = 5  # cap on native web searches per agent step

    # --- Compaction ---
    compaction_auto: bool = True
    compaction_reserved: int = 20_000

    # --- Agents (loaded from YAML) ---
    agents: dict[str, Any] | None = None

    # --- MCP (loaded from YAML) ---
    mcp: dict[str, Any] | None = None

    # --- OpenAI OAuth (ChatGPT Subscription) ---
    openai_oauth_access_token: str = ""
    openai_oauth_refresh_token: str = ""
    openai_oauth_account_id: str = ""
    openai_oauth_expires_at: int = 0  # milliseconds since epoch
    openai_oauth_email: str = ""

    # --- Google Workspace MCP Proxy ---
    google_client_id: str = ""
    google_client_secret: str = ""

    # --- Ollama (Local LLM) ---
    ollama_base_url: str = ""  # e.g. "http://localhost:11434" — empty = not configured
    ollama_auto_start: bool = True  # Auto-start managed Ollama binary on app launch
    ollama_last_model: str = ""  # Last-used model name for startup pre-warming

    # --- Local OpenAI-compatible endpoint ---
    local_base_url: str = ""  # OPENYAK_LOCAL_BASE_URL

    # --- Brave Search ---
    brave_search_api_key: str = ""

    # --- Full-Text Search ---
    fts_enabled: bool = True  # built-in FTS5, enabled by default (zero external deps)
    fts_auto_index: bool = True  # auto-index workspace on first access
    fts_poll_interval: float = 30.0  # seconds between re-index polls
    fts_max_file_size: int = 500_000  # bytes — skip files larger than this

    # --- Agent Limits ---
    max_steps: int = 50  # hard cap on agent loop iterations
    max_continuation_attempts: int = 10  # max nudges for incomplete todos
    max_tool_output_chars: int = 20_000  # truncate individual tool results beyond this
    max_assistant_content_chars: int = 40_000  # truncate accumulated assistant text
    max_request_context_chars: int = 160_000  # hard cap on total prompt size
    hard_max_output_tokens: int = 8192  # max tokens the model can generate per step
    min_output_tokens: int = 256  # minimum output tokens floor
    tool_timeout: int = 300  # seconds — per-tool execution timeout
    max_concurrent_generations: int = 20  # max parallel generation jobs

    # --- Tool Limits ---
    bash_timeout: int = 120  # default bash command timeout (seconds)
    bash_max_timeout: int = 600  # maximum bash timeout (seconds)
    subtask_max_depth: int = 3  # max nesting for sub-agent tasks
    subtask_timeout: int = 600  # seconds — sub-agent task timeout

    # --- Loop Detection ---
    loop_warn_threshold: int = 3  # warn after N repeated identical tool calls
    loop_hard_limit: int = 5  # hard-block after N repeated identical tool calls

    # --- Scheduler ---
    scheduler_poll_interval: int = 30  # seconds between task schedule checks
    scheduler_max_concurrent: int = 3  # max concurrent scheduled tasks

    # --- Shutdown ---
    shutdown_timeout: float = 8.0  # seconds to wait for active jobs on shutdown

    # --- Rate Limiting (remote access) ---
    rate_limit_max_requests: int = 120  # max requests per minute
    rate_limit_max_failed_auth: int = 5  # max failed auth attempts per minute

    # --- CSRF / Origin protection ---
    # Comma-separated list of additional allowed origins (exact match) for
    # cross-site state-changing requests. The defaults already cover the
    # Tauri desktop shell, loopback, and the Next.js dev server — only set
    # this to extend for unusual deployments (e.g. a custom web wrapper).
    extra_allowed_origins: str = ""  # OPENYAK_EXTRA_ALLOWED_ORIGINS

    # --- Messaging Channels (nanobot-based, in-process) ---
    channels_enabled: bool = True  # OPENYAK_CHANNELS_ENABLED
    channels_config_path: str = ""  # OPENYAK_CHANNELS_CONFIG_PATH (default: data/channels.json)

    # --- Remote Access ---
    remote_access_enabled: bool = False
    remote_token_path: str = "data/remote_token.json"
    remote_tunnel_mode: str = "cloudflare"  # "cloudflare" | "manual"
    remote_tunnel_url: str = ""  # Manual tunnel URL (when mode="manual")
    remote_permission_mode: str = "auto"  # "auto" | "ask" | "deny"

    # --- Local session auth ---
    # Rotated every backend start, written 0600 so another local user on a
    # shared host cannot read it. The desktop shell (Tauri) reads this file
    # after spawning the backend and injects the token on every request —
    # it never leaves the filesystem through the network layer.
    #
    # Path may be relative (resolved against cwd) or absolute. The
    # production launcher (``run.py``) chdirs into ``--data-dir`` and then
    # the Tauri shell polls ``<data_dir>/session_token.json``, so the
    # default below assumes that working-directory contract. Override via
    # the ``OPENYAK_SESSION_TOKEN_PATH`` env var when the contract differs
    # (the dev launcher does this — see ``scripts/dev-desktop.mjs`` —
    # because it runs uvicorn without invoking ``run.py``, so cwd stays
    # at ``backend/`` and the file needs to land under ``backend/data/``
    # to match what Tauri dev mode reads).
    session_token_path: str = "session_token.json"


@lru_cache
def get_settings() -> Settings:
    return Settings()

def get_custom_endpoints(settings: Settings) -> list[dict[str, Any]]:
    try:
        data = json.loads(settings.custom_endpoints)
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []
