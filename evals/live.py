"""Live evaluation providers configured without persisting credentials."""

from __future__ import annotations

import os

from app.provider.generic_openai import GenericOpenAIProvider


REALROUTER_BASE_URL = "https://api.realrouter.org/v1"
REALROUTER_KEY_ENV = "REALROUTER_API_KEY"


def create_realrouter_provider(model_id: str) -> GenericOpenAIProvider:
    """Create a production OpenAI-compatible provider from an environment key."""
    api_key = os.environ.get(REALROUTER_KEY_ENV, "")
    if not api_key:
        raise ValueError(
            f"Set {REALROUTER_KEY_ENV} to a newly created key before running live evaluations"
        )
    return GenericOpenAIProvider(
        api_key=api_key,
        provider_id="realrouter",
        base_url=REALROUTER_BASE_URL,
        kind="openai_compat_custom",
        models_override=[{"id": model_id, "name": model_id}],
    )
