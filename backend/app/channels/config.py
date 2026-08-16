"""Channel configuration schema for OpenYak.

Replaces the nanobot Config dependency with a lightweight schema
that reads from OpenYak's data/channels.json.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


logger = logging.getLogger(__name__)

# Default path for channels configuration
_DEFAULT_CONFIG_PATH = Path("data/channels.json")


class ChannelsConfig(BaseModel):
    """Top-level channels configuration."""

    # Per-channel configs stored as dicts (flexible schema per channel)
    # e.g. {"telegram": {"enabled": true, "token": "...", "allow_from": ["*"]}, ...}
    channels: dict[str, dict[str, Any]] = Field(default_factory=dict)

    # Global settings
    send_progress: bool = True
    send_tool_hints: bool = True
    send_max_retries: int = 3


def load_channels_config(config_path: Path | None = None) -> ChannelsConfig:
    """Load channels configuration from JSON file."""
    path = config_path or _DEFAULT_CONFIG_PATH
    if not path.exists():
        logger.info("No channels config at %s — using defaults", path)
        return ChannelsConfig()

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return ChannelsConfig.model_validate(data)
    except Exception as e:
        logger.warning("Failed to load channels config from %s: %s", path, e)
        return ChannelsConfig()


