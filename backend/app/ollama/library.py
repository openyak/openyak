"""Ollama model library — scrapes the official search page with local fallback.

Fetches ``https://ollama.com/search?q=...`` and parses the server-rendered
HTML to extract model data (name, description, sizes, pull count, capabilities).
Falls back to a curated local list when offline.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

CATEGORIES = ["chat", "code", "reasoning", "vision", "embedding"]

_OLLAMA_SEARCH_URL = "https://ollama.com/search"
_CACHE_TTL = 1800  # 30 minutes

# Per-query cache
_cache: dict[str, Any] = {}


# ── HTML parsing ──────────────────────────────────────────────────────────

# The Ollama search page uses custom attributes for test/scrape-friendly markup:
#   x-test-search-response-title  → model name
#   x-test-size                   → size tag (e.g. "7b", "32b")
#   x-test-pull-count             → pull count (e.g. "2.9M")
#   x-test-capability             → capability tag (e.g. "vision", "tools")
# Models are separated by <li> or similar block-level boundaries.

# Regex to split HTML into per-model blocks.
_BLOCK_SPLIT = re.compile(r'x-test-search-response-title>')

# Extractors for individual fields within a block.
_RE_TITLE = re.compile(r'^([^<]+)')
_RE_DESC = re.compile(r'text-neutral-800 text-md">\s*(.+?)\s*</p>', re.DOTALL)
_RE_SIZE = re.compile(r'x-test-size[^>]*>([^<]+)')
_RE_PULLS = re.compile(r'x-test-pull-count[^>]*>([^<]+)')
_RE_CAPABILITY = re.compile(r'x-test-capability[^>]*>([^<]+)')
_RE_UPDATED = re.compile(r'x-test-updated[^>]*>([^<]+)')


def _parse_pull_count(s: str) -> int:
    """Convert '2.9M' or '892.1K' to an integer."""
    s = s.strip()
    multiplier = 1
    if s.endswith("M"):
        multiplier = 1_000_000
        s = s[:-1]
    elif s.endswith("K"):
        multiplier = 1_000
        s = s[:-1]
    try:
        return int(float(s) * multiplier)
    except ValueError:
        return 0


def _infer_category_from_caps(name: str, capabilities: list[str]) -> str:
    """Infer category from capabilities and model name."""
    lower = name.lower()
    cap_set = {c.lower() for c in capabilities}

    if "embedding" in cap_set or "embed" in lower:
        return "embedding"
    if "vision" in cap_set or "-vl" in lower or "llava" in lower or "moondream" in lower:
        return "vision"
    if "coder" in lower or "code" in lower or "codestral" in lower or "devstral" in lower:
        return "code"
    if "thinking" in cap_set or "deepseek-r1" in lower or "qwq" in lower:
        return "reasoning"
    return "chat"


def _parse_search_html(html: str) -> list[dict]:
    """Parse Ollama search page HTML into model dicts."""
    # Split by the title marker — each segment (except the first) is a model block.
    blocks = _BLOCK_SPLIT.split(html)
    if len(blocks) <= 1:
        return []

    models: list[dict] = []
    for block in blocks[1:]:  # skip the preamble before first model
        # Title
        m_title = _RE_TITLE.match(block)
        if not m_title:
            continue
        name = m_title.group(1).strip()
        if not name:
            continue

        # Description
        m_desc = _RE_DESC.search(block)
        desc = m_desc.group(1).strip() if m_desc else ""
        # Clean HTML entities
        desc = desc.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"')

        # Sizes
        sizes = _RE_SIZE.findall(block)
        sizes = [s.strip() for s in sizes if s.strip()]

        # Pull count
        m_pulls = _RE_PULLS.search(block)
        pulls_str = m_pulls.group(1).strip() if m_pulls else "0"
        pulls = _parse_pull_count(pulls_str)

        # Capabilities
        capabilities = [c.strip() for c in _RE_CAPABILITY.findall(block)]

        # Category
        category = _infer_category_from_caps(name, capabilities)

        # Provider inference
        provider = _infer_provider(name)

        models.append({
            "name": name,
            "category": category,
            "sizes": sizes if sizes else ["latest"],
            "desc": desc,
            "provider": provider,
            "pulls": pulls,
            "pulls_formatted": pulls_str,
            "capabilities": capabilities,
        })

    return models


# ── Provider inference ────────────────────────────────────────────────────

_PROVIDER_MAP: dict[str, str] = {
    "llama": "Meta", "codellama": "Meta",
    "gemma": "Google", "codegemma": "Google",
    "qwen": "Alibaba", "qwq": "Alibaba",
    "phi": "Microsoft", "minilm": "Microsoft",
    "mistral": "Mistral AI", "codestral": "Mistral AI", "devstral": "Mistral AI",
    "deepseek": "DeepSeek",
    "minimax": "MiniMax",
    "kimi": "Moonshot AI",
    "glm": "Zhipu AI",
    "command": "Cohere",
    "starcoder": "BigCode",
    "llava": "LLaVA Team",
    "moondream": "vikhyat",
    "nomic": "Nomic AI",
    "mxbai": "mixedbread.ai",
    "vicuna": "LMSYS",
    "yi": "01.AI",
    "solar": "Upstage",
    "glm": "Zhipu AI",
    "internlm": "Shanghai AI Lab",
    "kimi": "Moonshot AI",
    "nemotron": "NVIDIA",
}


def _infer_provider(name: str) -> str:
    lower = name.lower()
    # Skip community models (contain '/')
    if "/" in name:
        parts = name.split("/")
        return parts[0]
    for key, provider in _PROVIDER_MAP.items():
        if key in lower:
            return provider
    return ""


# ── Remote fetch ──────────────────────────────────────────────────────────


async def _fetch_from_ollama(query: str | None = None, page: int = 1) -> list[dict] | None:
    """Fetch models from ollama.com/search. Returns None on failure."""
    try:
        params: dict[str, Any] = {}
        if query:
            params["q"] = query
        if page > 1:
            params["page"] = page

        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(_OLLAMA_SEARCH_URL, params=params)
            resp.raise_for_status()

        models = _parse_search_html(resp.text)
        if models:
            logger.debug("Parsed %d models from ollama.com/search (q=%s, page=%d)", len(models), query, page)
        return models
    except Exception as e:
        logger.debug("Failed to fetch from ollama.com/search: %s", e)
        return None


# ── Public API ────────────────────────────────────────────────────────────


async def get_library(
    query: str | None = None,
    page: int = 1,
    force_refresh: bool = False,
) -> tuple[list[dict], bool]:
    """Get model library — fetches from ollama.com with cache, fallback to local.

    Args:
        query: Optional search query.
        page: Page number (1-based).
        force_refresh: Force re-fetch (bypass cache).

    Returns:
        Tuple of (models, has_more) where has_more indicates if another page exists.
    """
    cache_key = f"{query or '__all__'}:p{page}"
    now = time.time()

    # Check cache
    if not force_refresh and cache_key in _cache:
        entry = _cache[cache_key]
        if now - entry["fetched_at"] < _CACHE_TTL:
            return entry["models"], entry["has_more"]

    # Fetch from ollama.com
    remote = await _fetch_from_ollama(query, page=page)
    if remote is not None:
        # If we got a full page of results, there's probably more
        has_more = len(remote) >= 15  # Ollama shows ~20 per page
        _cache[cache_key] = {"models": remote, "fetched_at": now, "has_more": has_more}
        return remote, has_more

    # Fallback: curated list (page 1 only)
    if page > 1:
        return [], False
    if query:
        q = query.lower()
        return [m for m in CURATED_MODELS if q in m["name"].lower() or q in m.get("desc", "").lower()], False
    return CURATED_MODELS, False


# ── Curated fallback list (offline) ───────────────────────────────────────

CURATED_MODELS: list[dict] = [
    {"name": "qwen3.5",         "category": "chat",      "sizes": ["0.8b", "2b", "4b", "9b", "27b", "35b", "122b"], "desc": "Qwen 3.5 — state-of-the-art multilingual model",     "provider": "Alibaba",     "pulls": 2_900_000},
    {"name": "qwen3",           "category": "chat",      "sizes": ["0.6b", "1.7b", "4b", "8b", "14b", "30b", "32b"], "desc": "Qwen 3 — latest generation, hybrid thinking",       "provider": "Alibaba",     "pulls": 24_700_000},
    {"name": "llama3.2",        "category": "chat",      "sizes": ["1b", "3b"],                                   "desc": "Meta Llama 3.2 — compact and capable",               "provider": "Meta",        "pulls": 50_000_000},
    {"name": "llama3.1",        "category": "chat",      "sizes": ["8b", "70b"],                                  "desc": "Meta Llama 3.1 — strong general-purpose model",      "provider": "Meta",        "pulls": 40_000_000},
    {"name": "gemma3",          "category": "chat",      "sizes": ["1b", "4b", "12b", "27b"],                     "desc": "Google Gemma 3 — efficient multilingual model",      "provider": "Google",      "pulls": 15_000_000},
    {"name": "phi4",            "category": "chat",      "sizes": ["14b"],                                        "desc": "Microsoft Phi 4 — strong reasoning in small form",   "provider": "Microsoft",   "pulls": 5_000_000},
    {"name": "mistral",         "category": "chat",      "sizes": ["7b"],                                         "desc": "Mistral 7B — fast and efficient",                    "provider": "Mistral AI",  "pulls": 30_000_000},
    {"name": "deepseek-r1",     "category": "reasoning", "sizes": ["1.5b", "7b", "8b", "14b", "32b", "70b"],      "desc": "DeepSeek R1 — chain-of-thought reasoning",          "provider": "DeepSeek",    "pulls": 25_000_000},
    {"name": "qwen2.5-coder",   "category": "code",      "sizes": ["1.5b", "3b", "7b", "14b", "32b"],             "desc": "Qwen 2.5 Coder — top-tier code generation",         "provider": "Alibaba",     "pulls": 12_700_000},
    {"name": "nomic-embed-text","category": "embedding", "sizes": ["137m"],                                       "desc": "Nomic Embed — high-quality text embeddings",         "provider": "Nomic AI",    "pulls": 8_000_000},
    {"name": "llava",           "category": "vision",    "sizes": ["7b", "13b"],                                  "desc": "LLaVA — visual instruction following",               "provider": "LLaVA Team",  "pulls": 6_000_000},
]
