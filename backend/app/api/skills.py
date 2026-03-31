"""Skill listing and toggle endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.dependencies import SkillRegistryDep
from app.skill.registry import SkillRegistry

router = APIRouter()


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
