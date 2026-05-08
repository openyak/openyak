"""Provider factory — creates Custom Endpoint provider instances by ID.

After v2.0.0, the only provider created through the factory is the user's
own Custom Endpoint (``custom_*`` IDs). All other providers are owned by
their dedicated bootstrap paths (Local OpenAI-compatible endpoint, OpenYak
Cloud proxy, OpenAI Subscription).
"""

from __future__ import annotations

import logging

from app.provider.base import BaseProvider

logger = logging.getLogger(__name__)


def create_provider(
    provider_id: str,
    api_key: str,
    *,
    base_url: str | None = None,
) -> BaseProvider:
    """Create a Custom Endpoint provider.

    Args:
        provider_id: Provider ID — must start with ``custom_``.
        api_key: API key for the endpoint (may be empty for unauthenticated).
        base_url: Endpoint base URL (required).

    Raises:
        ValueError: For non-custom IDs or missing base_url.
    """
    if not provider_id.startswith("custom_"):
        raise ValueError(
            f"Unknown provider: '{provider_id}'. Only Custom Endpoints "
            "(IDs starting with 'custom_') are supported."
        )
    if not base_url:
        raise ValueError(f"Custom endpoint '{provider_id}' requires a base_url.")

    from app.provider.generic_openai import GenericOpenAIProvider

    return GenericOpenAIProvider(
        api_key=api_key,
        provider_id=provider_id,
        base_url=base_url,
        kind="openai_compat_custom",
    )
