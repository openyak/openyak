"""Declarative knobs for chat-style Channels (ADR-0006)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ChatProfile:
    """Per-vendor knobs consumed by :class:`ChatChannel`.

    The profile is data, not behaviour — every value here describes a vendor
    constraint or an operational tuning, never how to call an API. API calls
    live behind :class:`VendorTransport`.

    Attributes:
        max_message_len: Largest text payload the vendor will accept in one
            message. Longer outbound text is split by the chunker (Telegram
            4000, Slack ~40000, Feishu 30000).
        stream_edit_interval: Minimum seconds between consecutive
            ``edit_text`` calls during streaming. Vendors flood-control
            edits — Telegram caps around 1/s per chat in practice. 0.6 is
            a safe default.
        media_group_buffer_ms: Window during which inbound media-group
            messages are batched into a single bus dispatch. ``0`` disables
            batching (transports without media groups, e.g. Slack).
        typing_indicator_interval: Seconds between repeats of the typing
            indicator while a turn is in flight. ``0`` disables typing
            (vendors without the concept).
        send_retries: How many times to retry a vendor send on transient
            failures (timeout, rate limit). The retry loop uses exponential
            backoff starting at ``send_retry_base_delay``.
        send_retry_base_delay: Initial backoff delay in seconds; doubles
            each retry.
        supports_edit: Whether the vendor supports editing a previously-
            sent message. False forces ``ChatChannel`` to send each delta
            as a new message instead of editing in place; rarely toggled —
            most chat vendors support it.
    """

    max_message_len: int
    stream_edit_interval: float = 0.6
    media_group_buffer_ms: int = 600
    typing_indicator_interval: float = 4.0
    send_retries: int = 3
    send_retry_base_delay: float = 0.5
    supports_edit: bool = True
