"""Chat-style Channel scaffolding (ADR-0006).

`ChatChannel` is the fast path for chat-style Channels — Feishu, WeChat,
Telegram, Slack, Discord, DingTalk — that share ~80% of their wiring:
inbound dispatch with allowlist + mention/reply policy, streaming-card
buffer with edit throttling, media-group buffer, text chunking, retry
with backoff, typing indicator loop. The vendor-specific bits — auth,
send/edit/upload API calls, markdown rendering, mention parsing — are
provided through an injected :class:`VendorTransport` Protocol.

Channels that don't fit the chat shape (Email, RSS, voice) continue to
subclass :class:`app.channels.base.BaseChannel` directly.
"""

from __future__ import annotations

from app.channels.chat.channel import ChatChannel
from app.channels.chat.profile import ChatProfile
from app.channels.chat.recording import RecordingTransport, RecordedCall
from app.channels.chat.transport import (
    ChatInbound,
    MediaKind,
    VendorMessageRef,
    VendorTransport,
)

__all__ = [
    "ChatChannel",
    "ChatInbound",
    "ChatProfile",
    "MediaKind",
    "RecordedCall",
    "RecordingTransport",
    "VendorMessageRef",
    "VendorTransport",
]
