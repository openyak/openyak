"""Skill listing, toggle, and store endpoints.

The *store* endpoints serve a **bundled snapshot** of the top skills
scraped from https://skillsmp.com (see
``scripts/update_skills_catalog.py``). Hitting SkillsMP live every time
a user opens the browser is a non-starter: their anon quota is 50
req/day per IP, which burns out under debounced search-as-you-type.
Instead we ship a JSON catalog and refresh it on each OpenYak release.

Install still uses live GitHub raw content so the actual SKILL.md
body is always authoritative; only discovery is offline.
"""

from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.dependencies import SkillRegistryDep
from app.skill.registry import SkillRegistry

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------
# Store catalog (bundled JSON, refreshed per-release)
# ---------------------------------------------------------------------

_CATALOG_PATH = Path(__file__).resolve().parent.parent / "data" / "skills_catalog.json"
_STORE_HTTP_TIMEOUT = 10.0


@lru_cache(maxsize=1)
def _load_catalog() -> tuple[list[dict[str, Any]], int]:
    """Return ``(skills, generated_at)``; cached for process lifetime.

    The bundled catalog is immutable at runtime — release bumps it by
    re-running the scrape script and rebuilding the backend wheel.
    """
    if not _CATALOG_PATH.is_file():
        logger.warning("Skills catalog missing at %s", _CATALOG_PATH)
        return [], 0
    try:
        data = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logger.warning("Skills catalog unreadable: %s", e)
        return [], 0
    skills = data.get("skills") or []
    if not isinstance(skills, list):
        return [], 0
    return skills, int(data.get("generated_at") or 0)


def _skill_source(skill_name: str, location: str) -> str:
    """Determine the source of a skill: 'plugin', 'bundled', or 'project'."""
    if ":" in skill_name:
        return "plugin"
    if "/data/skills/" in location or "\\data\\skills\\" in location:
        return "bundled"
    return "project"


def _skill_to_dict(skill, registry: SkillRegistry) -> dict[str, Any]:
    """Convert a SkillInfo to an API response dict."""
    return {
        "name": skill.name,
        "description": skill.description,
        "location": skill.location,
        "source": _skill_source(skill.name, skill.location),
        "enabled": not registry.is_disabled(skill.name),
    }


@router.get("/skills")
async def list_skills(registry: SkillRegistryDep) -> list[dict[str, Any]]:
    """List all discovered skills."""
    return [_skill_to_dict(skill, registry) for skill in registry.all_skills()]


@router.get("/skills/{skill_name}")
async def get_skill(registry: SkillRegistryDep, skill_name: str) -> dict[str, Any]:
    """Get skill details including full content."""
    skill = registry.get(skill_name)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"Skill not found: {skill_name}")
    return {
        "name": skill.name,
        "description": skill.description,
        "location": skill.location,
        "content": skill.content,
    }


@router.post("/skills/{skill_name}/enable")
async def enable_skill(registry: SkillRegistryDep, skill_name: str) -> dict[str, Any]:
    """Enable a disabled skill."""
    skill = registry.get(skill_name)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"Skill not found: {skill_name}")
    registry.enable(skill_name)
    return {
        "success": True,
        "skills": [_skill_to_dict(s, registry) for s in registry.all_skills()],
    }


@router.post("/skills/{skill_name}/disable")
async def disable_skill(registry: SkillRegistryDep, skill_name: str) -> dict[str, Any]:
    """Disable a skill (excludes it from LLM available skills)."""
    skill = registry.get(skill_name)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"Skill not found: {skill_name}")
    registry.disable(skill_name)
    return {
        "success": True,
        "skills": [_skill_to_dict(s, registry) for s in registry.all_skills()],
    }


# ---------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------


class InstallRequest(BaseModel):
    """Body for ``POST /api/skills/install``."""

    github_url: str
    # Optional display name; if absent we derive it from the resolved
    # SKILL.md frontmatter or the GitHub path.
    name: str | None = None


_GITHUB_BLOB = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?:blob|tree)/"
    r"(?P<ref>[^/]+)/(?P<path>.+?)(?:/SKILL\.md)?/?$"
)


def _github_to_raw(url: str) -> str:
    """Convert a github.com URL to its raw.githubusercontent.com equivalent.

    Handles both ``blob`` (file) and ``tree`` (directory) URLs. For
    directories we assume the target is ``SKILL.md`` at the root of the
    directory — this matches the skills-ecosystem convention.
    """
    m = _GITHUB_BLOB.match(url.strip())
    if not m:
        raise ValueError(f"Unsupported GitHub URL: {url!r}")
    owner, repo, ref, path = m["owner"], m["repo"], m["ref"], m["path"]
    # Strip a trailing ``SKILL.md`` the regex already handled, but if the
    # user passed a bare directory URL the regex drops the segment too;
    # re-append unconditionally so raw-content always points at the file.
    if not path.endswith("SKILL.md"):
        path = f"{path.rstrip('/')}/SKILL.md"
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}"


def _slug(name: str) -> str:
    """Filesystem-safe slug for the install directory name."""
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip()).strip("-").lower()
    return slug or "skill"


def _global_skills_dir() -> Path:
    d = Path.home() / ".openyak" / "skills"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _updated_at_key(skill: dict[str, Any]) -> float:
    """Comparable key for ``updatedAt`` — handles both int and ISO string."""
    v = skill.get("updatedAt")
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        # ISO-8601 sorts lexicographically; hash isn't ideal but we only
        # need a total order. Convert to a numeric-ish fallback.
        try:
            from datetime import datetime
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _matches(skill: dict[str, Any], needle: str) -> bool:
    for field in ("name", "description", "author"):
        value = skill.get(field)
        if isinstance(value, str) and needle in value.lower():
            return True
    return False


def _paginate(
    skills: list[dict[str, Any]],
    page: int,
    limit: int,
    q: str,
    sort: str,
) -> dict[str, Any]:
    total = len(skills)
    total_pages = (total + limit - 1) // limit if limit else 0
    start = (page - 1) * limit
    end = start + limit
    page_skills = skills[start:end]
    return {
        "success": True,
        "data": {
            "skills": page_skills,
            "pagination": {
                "page": page,
                "limit": limit,
                "total": total,
                "totalPages": total_pages,
                "hasNext": end < total,
                "hasPrev": page > 1,
                "totalIsExact": True,
            },
            "filters": {"search": q, "sortBy": sort},
        },
        "meta": {"source": "bundled", "generatedAt": _load_catalog()[1]},
    }


@router.get("/skills/store/search")
async def search_skill_store(
    q: str = "",
    page: int = 1,
    limit: int = 20,
    sort: str = "stars",
) -> dict[str, Any]:
    """Serve the bundled skills catalog (no external network call).

    - Empty ``q`` → top ``limit`` skills from the catalog, paginated.
    - Non-empty ``q`` → case-insensitive substring filter over
      ``name``, ``description``, and ``author``.
    - ``sort`` ∈ {``stars``, ``recent``}.
    """
    limit = max(1, min(limit, 50))
    page = max(1, page)
    sort = sort if sort in ("stars", "recent") else "stars"

    catalog, _generated_at = _load_catalog()
    needle = q.strip().lower()

    pool = [s for s in catalog if _matches(s, needle)] if needle else list(catalog)

    if sort == "recent":
        pool.sort(key=_updated_at_key, reverse=True)
    else:  # "stars" (default) — stable fallback on updatedAt for ties
        pool.sort(
            key=lambda s: (-(s.get("stars") or 0), -_updated_at_key(s)),
        )

    return _paginate(pool, page, limit, q, sort)


@router.post("/skills/install")
async def install_skill(
    registry: SkillRegistryDep,
    body: InstallRequest,
) -> dict[str, Any]:
    """Download a SKILL.md from GitHub and install it to the global
    user skills directory (``~/.openyak/skills/<slug>/SKILL.md``).

    The registry is rescanned so the new skill is immediately available
    without restarting the backend. Existing skills with the same
    filesystem slug are overwritten (enabling a simple "update" flow).
    """
    try:
        raw_url = _github_to_raw(body.github_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        async with httpx.AsyncClient(
            timeout=_STORE_HTTP_TIMEOUT,
            follow_redirects=True,
        ) as client:
            resp = await client.get(raw_url)
    except httpx.HTTPError as e:
        logger.warning("Skill download failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not download skill from GitHub") from e

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=f"SKILL.md not found at {raw_url}")
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"GitHub returned {resp.status_code} for SKILL.md",
        )

    content = resp.text
    if not content.lstrip().startswith("---"):
        raise HTTPException(
            status_code=422,
            detail="Downloaded file does not look like a valid SKILL.md (no YAML frontmatter)",
        )

    slug = _slug(body.name or body.github_url.rstrip("/").rsplit("/", 1)[-1])
    target_dir = _global_skills_dir() / slug
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / "SKILL.md"
    target_path.write_text(content, encoding="utf-8")

    # Rescan the registry so the new skill shows up in /api/skills
    # without a backend restart. scan() is additive (it doesn't clear
    # existing entries), which is what we want here.
    registry.scan()

    return {
        "success": True,
        "location": str(target_path),
        "skills": [_skill_to_dict(s, registry) for s in registry.all_skills()],
    }
