"""Workspace memory system configuration."""

from __future__ import annotations

from pydantic import BaseModel, Field


class MemoryConfig(BaseModel):
    """Configuration for the workspace-scoped memory system."""

    enabled: bool = True
    max_lines: int = Field(default=200, ge=10, le=500)
    debounce_seconds: int = Field(default=10, ge=2, le=120)


# Module-level default config
_config = MemoryConfig()


def get_memory_config() -> MemoryConfig:
    return _config


def set_memory_config(config: MemoryConfig) -> None:
    global _config
    _config = config
