"""Application configuration via Pydantic Settings."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
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
    openrouter_api_key: str = ""

    # --- Direct Provider API Keys (BYOK) ---
    openai_api_key: str = ""        # OPENYAK_OPENAI_API_KEY
    anthropic_api_key: str = ""     # OPENYAK_ANTHROPIC_API_KEY
    google_api_key: str = ""        # OPENYAK_GOOGLE_API_KEY
    groq_api_key: str = ""          # OPENYAK_GROQ_API_KEY
    deepseek_api_key: str = ""      # OPENYAK_DEEPSEEK_API_KEY
    mistral_api_key: str = ""       # OPENYAK_MISTRAL_API_KEY
    xai_api_key: str = ""           # OPENYAK_XAI_API_KEY
    together_api_key: str = ""      # OPENYAK_TOGETHER_API_KEY
    deepinfra_api_key: str = ""     # OPENYAK_DEEPINFRA_API_KEY
    cerebras_api_key: str = ""      # OPENYAK_CEREBRAS_API_KEY
    cohere_api_key: str = ""        # OPENYAK_COHERE_API_KEY
    perplexity_api_key: str = ""    # OPENYAK_PERPLEXITY_API_KEY
    fireworks_api_key: str = ""     # OPENYAK_FIREWORKS_API_KEY
    azure_openai_api_key: str = ""  # OPENYAK_AZURE_OPENAI_API_KEY
    azure_openai_base_url: str = "" # OPENYAK_AZURE_OPENAI_BASE_URL
    qwen_api_key: str = ""          # OPENYAK_QWEN_API_KEY (Alibaba DashScope)
    kimi_api_key: str = ""          # OPENYAK_KIMI_API_KEY (Moonshot)
    minimax_api_key: str = ""       # OPENYAK_MINIMAX_API_KEY
    zhipu_api_key: str = ""         # OPENYAK_ZHIPU_API_KEY (智谱 GLM)
    siliconflow_api_key: str = ""   # OPENYAK_SILICONFLOW_API_KEY (硅基流动)
    xiaomi_api_key: str = ""        # OPENYAK_XIAOMI_API_KEY (MiMo)
    custom_endpoints: str = "[]"    # OPENYAK_CUSTOM_ENDPOINTS

    # Comma-separated list of provider IDs to disable (e.g. "groq,deepseek")
    # Disabled providers are not registered even if their API key is set.
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

    # --- Project ---
    project_dir: str = "."

    # --- Web Search ---
    daily_search_limit: int = 20  # Max free web_search calls per day (Free/BYOK)
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

    # --- OpenClaw Bridge (Messaging Channels) ---
    openclaw_enabled: bool = False  # OPENYAK_OPENCLAW_ENABLED
    openclaw_url: str = "ws://127.0.0.1:18789"  # OPENYAK_OPENCLAW_URL
    openclaw_token: str = ""  # OPENYAK_OPENCLAW_TOKEN

    # --- Remote Access ---
    remote_access_enabled: bool = False
    remote_token_path: str = "data/remote_token.json"
    remote_tunnel_mode: str = "cloudflare"  # "cloudflare" | "manual"
    remote_tunnel_url: str = ""  # Manual tunnel URL (when mode="manual")
    remote_permission_mode: str = "auto"  # "auto" | "ask" | "deny"


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
