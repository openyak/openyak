"""Vendor I/O Protocol consumed by :class:`ChatChannel` (ADR-0006).

A transport implements the vendor-specific half of a chat Channel:
authentication, listening for inbound events, sending and editing
messages, uploading media, vendor-specific markdown rendering, and the
opaque tokens needed to track reactions. The other half — allowlist,
group-policy gating, streaming buffer, media-group batching, typing
loop, chunking, retry — lives in :class:`ChatChannel` and is shared
across vendors.

The Protocol is structural (``typing.Protocol``), not nominal: vendors
do not need to subclass it. That keeps the surface narrow — adding a
new transport is "implement these methods on a class", not "carry the
weight of an inheritance chain".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Protocol, runtime_checkable


MediaKind = Literal["photo", "voice", "audio", "video", "animation", "document"]


class NonRetryableTransportError(Exception):
    """Vendor signal that a transport call must not be retried.

    ``ChatChannel._with_retry`` catches this specifically and re-raises
    on the first occurrence — the exponential-backoff loop only fires
    for plain :class:`Exception` subclasses. Vendor transports raise
    this for permanent failures the channel layer can't recover from
    (e.g. malformed payload, unauthorised credential, deleted chat
    target) so retrying would just burn rate-limit budget.
    """


@dataclass(frozen=True)
class VendorMessageRef:
    """Opaque reference to a message that lives on the vendor side.

    Returned from :meth:`VendorTransport.send_text` and
    :meth:`VendorTransport.send_media` so ``ChatChannel`` can later
    target the same message for edits, reactions, or threaded replies
    without learning the vendor's id shape. ``message_id`` is always a
    string (vendors use ints, strings, or composite tokens — we string-
    ify for uniformity); ``extra`` carries any vendor-specific bits the
    transport needs to thread back through (e.g. Telegram's
    ``message_thread_id``, Slack's channel-versus-DM split).
    """

    chat_id: str
    message_id: str
    extra: Any = None


@dataclass
class ChatInbound:
    """Vendor-agnostic inbound event produced by the transport.

    The transport listens to its vendor's wire format (long-poll updates
    for Telegram, webhook events for Slack, websocket frames for Feishu),
    translates one event into this shape, and hands it to ``ChatChannel``
    via the ``on_inbound`` callback. ``ChatChannel`` then runs allowlist,
    group-policy, and media-group-batching policy on it before
    publishing to the bus.
    """

    sender_id: str
    chat_id: str
    content: str
    message_ref: VendorMessageRef
    media: list[str] = field(default_factory=list)
    is_group: bool = False
    is_mention_to_bot: bool = False
    is_reply_to_bot: bool = False
    media_group_id: str | None = None
    thread_id: str | None = None
    session_key: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# Type alias for clarity — each transport is given this callback at
# ``start()`` and must invoke it for every inbound event.
InboundHandler = Callable[[ChatInbound], Awaitable[None]]


@runtime_checkable
class VendorTransport(Protocol):
    """Vendor-specific I/O primitives. Implement structurally.

    Every method is awaited; transports that wrap a synchronous SDK
    should run blocking calls in a thread executor so the Channel's
    event loop is never blocked.
    """

    name: str

    # ---- Lifecycle --------------------------------------------------

    async def start(self, on_inbound: InboundHandler) -> None:
        """Begin listening for vendor events. Returns once the listener
        is up; the listener itself runs until :meth:`stop` is called."""
        ...

    async def stop(self) -> None:
        """Stop the listener and release vendor resources."""
        ...

    # ---- Outbound ---------------------------------------------------

    async def send_text(
        self,
        chat_id: str,
        text: str,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef:
        """Send a text message. The transport is responsible for any
        vendor-specific rendering (markdown→HTML, mrkdwn, etc.) — see
        :meth:`render_text`."""
        ...

    async def edit_text(
        self,
        ref: VendorMessageRef,
        text: str,
    ) -> None:
        """Replace the body of a previously-sent message. Called only
        when ``ChatProfile.supports_edit`` is True."""
        ...

    async def send_media(
        self,
        chat_id: str,
        media_path: str,
        kind: MediaKind,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef | None:
        """Upload and send a single media file. Returns the vendor ref
        if the platform exposes one, ``None`` if the upload is fire-and-
        forget (some vendors don't return ids for media)."""
        ...

    # ---- UX feedback -----------------------------------------------

    async def show_typing(self, chat_id: str) -> None:
        """Best-effort typing indicator. Transports without the concept
        no-op."""
        ...

    async def add_reaction(
        self,
        ref: VendorMessageRef,
        emoji: str,
    ) -> Any:
        """Add an emoji reaction. Returns an opaque token that
        :meth:`remove_reaction` will need (Feishu's ``reaction_id``,
        Slack's emoji name, ``None`` for vendors that key removal off
        the message ref alone)."""
        ...

    async def remove_reaction(
        self,
        ref: VendorMessageRef,
        token: Any,
    ) -> None:
        """Remove a previously-added reaction using the token returned
        from :meth:`add_reaction`."""
        ...

    # ---- Rendering --------------------------------------------------

    def render_text(self, markdown: str) -> str:
        """Translate generic markdown into the vendor's rendered form
        (Telegram HTML, Slack mrkdwn, Feishu rich-text). Pass-through
        is a fine default for vendors with no special form."""
        ...

    def render_quote(self, text: str) -> str:
        """Render text as a quoted block (used by ChatChannel for
        tool-hint sections). Vendors without quoting render the same
        as :meth:`render_text`."""
        ...
