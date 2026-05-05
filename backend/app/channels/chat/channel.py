"""``ChatChannel`` — shared scaffolding for chat-style Channels (ADR-0006).

Composes a :class:`VendorTransport` with a :class:`ChatProfile` to deliver
the eight pieces of behaviour every chat Channel needs:

1. **Allowlist + group-policy gating** — filters out unauthorised senders
   and (in groups) messages that don't mention the bot or reply to it,
   reusing :meth:`BaseChannel.is_allowed` for the first half.
2. **Reaction tracking** — adds an inbound emoji reaction when a turn
   starts, removes it when the final response sends. Uses the opaque
   token returned by :meth:`VendorTransport.add_reaction` so vendors
   that need a reaction id (Feishu) and vendors that don't (Telegram)
   share the same code path.
3. **Typing indicator loop** — best-effort visible feedback while a turn
   is in flight; cancelled on send completion.
4. **Media-group buffer** — vendors that emit one inbound event per
   media item in an album (Telegram, Feishu) get coalesced into a
   single ``InboundMessage``.
5. **Streaming buffer with edit-throttle** — the streaming-card pattern:
   first delta sends a new message and stores the ref, subsequent deltas
   edit it in place, throttled by ``profile.stream_edit_interval``.
6. **Text chunking** — outbound text longer than ``profile.max_message_len``
   is split via :func:`app.channels.helpers.split_message`.
7. **Send retry with backoff** — wraps every transport send/edit call with
   ``profile.send_retries`` exponential-backoff attempts.
8. **Lifecycle** — ``start()`` hands the transport an inbound callback;
   ``stop()`` cancels typing tasks, flushes pending media-group buffers,
   and tears down the transport.

Vendor-specific behaviour — auth, polling, parsing, markdown rendering,
API call shapes — lives behind :class:`VendorTransport`. The
:class:`RecordingTransport` test adapter exercises every code path here
without any real vendor SDK in the loop.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from app.channels.base import BaseChannel
from app.channels.bus.events import OutboundMessage
from app.channels.bus.queue import MessageBus
from app.channels.chat.profile import ChatProfile
from app.channels.chat.transport import (
    ChatInbound,
    VendorMessageRef,
    VendorTransport,
)
from app.channels.helpers import split_message

logger = logging.getLogger(__name__)


@dataclass
class _StreamBuf:
    """Per-chat accumulator that backs streaming-card editing."""

    text: str = ""
    ref: VendorMessageRef | None = None
    last_edit_perf: float = 0.0
    stream_id: str | None = None


@dataclass
class _MediaGroupBuf:
    """Per-(chat,group_id) accumulator backing media-group coalescing."""

    sender_id: str
    chat_id: str
    contents: list[str] = field(default_factory=list)
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    session_key: str | None = None
    first_message_ref: VendorMessageRef | None = None


class ChatChannel(BaseChannel):
    """Concrete :class:`BaseChannel` for chat-style vendors.

    Subclass this only to override the ``name`` / ``display_name`` class
    attributes for routing — most behaviour comes from the injected
    :class:`VendorTransport` plus the :class:`ChatProfile`. The Telegram
    Channel, for example, is a 30-line composer that wires
    ``TelegramTransport`` to the right ``ChatProfile`` and inherits the
    rest from here.
    """

    def __init__(
        self,
        config: Any,
        bus: MessageBus,
        *,
        transport: VendorTransport,
        profile: ChatProfile,
    ) -> None:
        super().__init__(config, bus)
        self.transport = transport
        self.profile = profile
        self._typing_tasks: dict[str, asyncio.Task] = {}
        self._stream_bufs: dict[str, _StreamBuf] = {}
        self._media_group_buffers: dict[str, _MediaGroupBuf] = {}
        self._media_group_tasks: dict[str, asyncio.Task] = {}
        # (chat_id, message_id) -> opaque reaction token from transport.
        # Looked up at send-time to remove the inbound reaction once the
        # final response goes out.
        self._reaction_tokens: dict[tuple[str, str], Any] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._running = True
        await self.transport.start(on_inbound=self._handle_inbound_envelope)

    async def stop(self) -> None:
        self._running = False
        for chat_id in list(self._typing_tasks):
            self._stop_typing(chat_id)
        for task in self._media_group_tasks.values():
            task.cancel()
        self._media_group_tasks.clear()
        self._media_group_buffers.clear()
        self._stream_bufs.clear()
        self._reaction_tokens.clear()
        await self.transport.stop()

    @property
    def supports_streaming(self) -> bool:
        cfg = self.config
        streaming = cfg.get("streaming", False) if isinstance(cfg, dict) else getattr(cfg, "streaming", False)
        return bool(streaming) and self.profile.supports_edit

    # ------------------------------------------------------------------
    # Inbound — allowlist + group-policy + media-group buffer + dispatch
    # ------------------------------------------------------------------

    async def _handle_inbound_envelope(self, env: ChatInbound) -> None:
        """Callback for the transport. Applies policy, then dispatches."""
        if not self.is_allowed(env.sender_id):
            logger.info(
                "%s: dropped inbound from sender %s (not in allow_from)",
                self.name, env.sender_id,
            )
            return

        if env.is_group and not self._group_message_for_bot(env):
            return

        if env.media_group_id and self.profile.media_group_buffer_ms > 0:
            await self._buffer_media_group(env)
            return

        await self._dispatch_inbound(env)

    def _group_message_for_bot(self, env: ChatInbound) -> bool:
        """Apply ``group_policy``: open lets everything through, mention
        requires either an @mention or a reply to a bot message."""
        policy = getattr(self.config, "group_policy", "mention")
        if isinstance(self.config, dict):
            policy = self.config.get("group_policy", "mention")
        if policy == "open":
            return True
        return env.is_mention_to_bot or env.is_reply_to_bot

    async def _buffer_media_group(self, env: ChatInbound) -> None:
        """Coalesce album-style inbound events into one bus dispatch."""
        key = f"{env.chat_id}:{env.media_group_id}"
        buf = self._media_group_buffers.get(key)
        if buf is None:
            buf = _MediaGroupBuf(
                sender_id=env.sender_id,
                chat_id=env.chat_id,
                metadata=dict(env.metadata),
                session_key=env.session_key,
                first_message_ref=env.message_ref,
            )
            self._media_group_buffers[key] = buf
            self._start_typing(env.chat_id)
            await self._react_to_inbound(env)

        if env.content:
            buf.contents.append(env.content)
        buf.media.extend(env.media)

        if key not in self._media_group_tasks:
            self._media_group_tasks[key] = asyncio.create_task(
                self._flush_media_group(key),
                name=f"media-group-{key[:24]}",
            )

    async def _flush_media_group(self, key: str) -> None:
        try:
            await asyncio.sleep(self.profile.media_group_buffer_ms / 1000)
            buf = self._media_group_buffers.pop(key, None)
            if buf is None:
                return
            content = "\n".join(buf.contents) if buf.contents else "[empty message]"
            await self._handle_message(
                sender_id=buf.sender_id,
                chat_id=buf.chat_id,
                content=content,
                media=list(dict.fromkeys(buf.media)),
                metadata=buf.metadata,
                session_key=buf.session_key,
            )
        finally:
            self._media_group_tasks.pop(key, None)

    async def _dispatch_inbound(self, env: ChatInbound) -> None:
        """Non-media-group path: react, type, then publish."""
        await self._react_to_inbound(env)
        self._start_typing(env.chat_id)
        await self._handle_message(
            sender_id=env.sender_id,
            chat_id=env.chat_id,
            content=env.content,
            media=list(env.media),
            metadata=env.metadata,
            session_key=env.session_key,
        )

    async def _react_to_inbound(self, env: ChatInbound) -> None:
        """Best-effort emoji reaction on the inbound message."""
        emoji = self._react_emoji()
        if not emoji:
            return
        try:
            token = await self.transport.add_reaction(env.message_ref, emoji)
        except Exception as exc:
            logger.debug("%s: add_reaction failed: %s", self.name, exc)
            return
        self._reaction_tokens[
            (env.message_ref.chat_id, env.message_ref.message_id)
        ] = token

    def _react_emoji(self) -> str | None:
        cfg = self.config
        if isinstance(cfg, dict):
            return cfg.get("react_emoji")
        return getattr(cfg, "react_emoji", None)

    # ------------------------------------------------------------------
    # Outbound — send + retry + chunking + reaction cleanup
    # ------------------------------------------------------------------

    async def send(self, msg: OutboundMessage) -> None:
        is_progress = bool(msg.metadata.get("_progress"))
        if not is_progress:
            self._stop_typing(msg.chat_id)
            await self._remove_inbound_reaction(msg)

        reply_ref = self._inbound_ref_from_outbound(msg)
        thread_id = self._thread_id_from_outbound(msg)

        for media_path in msg.media or []:
            kind = self._infer_media_kind(media_path)
            try:
                await self._with_retry(
                    self.transport.send_media,
                    msg.chat_id,
                    media_path,
                    kind,
                    reply_to=reply_ref,
                    thread_id=thread_id,
                )
            except Exception as exc:
                logger.error("%s: media send failed for %s: %s", self.name, media_path, exc)

        if msg.content and msg.content != "[empty message]":
            render = (
                self.transport.render_quote
                if msg.metadata.get("_tool_hint")
                else self.transport.render_text
            )
            for chunk in split_message(msg.content, self.profile.max_message_len):
                await self._with_retry(
                    self.transport.send_text,
                    msg.chat_id,
                    render(chunk),
                    reply_to=reply_ref,
                    thread_id=thread_id,
                )

    async def send_delta(
        self,
        chat_id: str,
        delta: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if not self.profile.supports_edit:
            # Vendors without edit fall back to chunked send-on-end.
            return
        meta = metadata or {}
        stream_id = meta.get("_stream_id")

        if meta.get("_stream_end"):
            await self._finalize_stream(chat_id, stream_id, meta)
            return

        buf = self._stream_bufs.get(chat_id)
        if buf is None or (
            stream_id is not None and buf.stream_id is not None and buf.stream_id != stream_id
        ):
            buf = _StreamBuf(stream_id=stream_id)
            self._stream_bufs[chat_id] = buf
        elif buf.stream_id is None:
            buf.stream_id = stream_id

        buf.text += delta
        if not buf.text.strip():
            return

        thread_id = meta.get("message_thread_id")
        now_perf = time.perf_counter()

        if buf.ref is None:
            try:
                buf.ref = await self._with_retry(
                    self.transport.send_text,
                    chat_id,
                    self.transport.render_text(buf.text),
                    thread_id=thread_id,
                )
                buf.last_edit_perf = now_perf
            except Exception as exc:
                logger.warning("%s: stream initial send failed: %s", self.name, exc)
                raise
        elif (now_perf - buf.last_edit_perf) >= self.profile.stream_edit_interval:
            try:
                await self._with_retry(
                    self.transport.edit_text,
                    buf.ref,
                    self.transport.render_text(buf.text),
                )
                buf.last_edit_perf = now_perf
            except Exception as exc:
                logger.warning("%s: stream edit failed: %s", self.name, exc)
                raise

    async def _finalize_stream(
        self,
        chat_id: str,
        stream_id: Any,
        meta: dict[str, Any],
    ) -> None:
        buf = self._stream_bufs.get(chat_id)
        if not buf or not buf.ref or not buf.text:
            return
        if stream_id is not None and buf.stream_id is not None and buf.stream_id != stream_id:
            return

        self._stop_typing(chat_id)
        await self._remove_inbound_reaction_by_meta(meta, chat_id)

        chunks = split_message(buf.text, self.profile.max_message_len)
        primary = chunks[0] if chunks else buf.text
        try:
            await self._with_retry(
                self.transport.edit_text,
                buf.ref,
                self.transport.render_text(primary),
            )
        except Exception as exc:
            logger.warning("%s: final stream edit failed: %s", self.name, exc)

        thread_id = meta.get("message_thread_id")
        for extra in chunks[1:]:
            await self._with_retry(
                self.transport.send_text,
                chat_id,
                self.transport.render_text(extra),
                thread_id=thread_id,
            )
        self._stream_bufs.pop(chat_id, None)

    # ------------------------------------------------------------------
    # Typing indicator
    # ------------------------------------------------------------------

    def _start_typing(self, chat_id: str) -> None:
        if self.profile.typing_indicator_interval <= 0:
            return
        self._stop_typing(chat_id)
        self._typing_tasks[chat_id] = asyncio.create_task(
            self._typing_loop(chat_id),
            name=f"typing-{self.name}-{chat_id[:24]}",
        )

    def _stop_typing(self, chat_id: str) -> None:
        task = self._typing_tasks.pop(chat_id, None)
        if task and not task.done():
            task.cancel()

    async def _typing_loop(self, chat_id: str) -> None:
        try:
            while self._running:
                try:
                    await self.transport.show_typing(chat_id)
                except Exception as exc:
                    logger.debug("%s: typing indicator failed: %s", self.name, exc)
                    return
                await asyncio.sleep(self.profile.typing_indicator_interval)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Reaction cleanup helpers
    # ------------------------------------------------------------------

    async def _remove_inbound_reaction(self, msg: OutboundMessage) -> None:
        message_id = msg.metadata.get("message_id")
        if message_id is None:
            return
        await self._remove_reaction_by_keys(msg.chat_id, str(message_id))

    async def _remove_inbound_reaction_by_meta(
        self,
        meta: dict[str, Any],
        chat_id: str,
    ) -> None:
        message_id = meta.get("message_id")
        if message_id is None:
            return
        await self._remove_reaction_by_keys(chat_id, str(message_id))

    async def _remove_reaction_by_keys(self, chat_id: str, message_id: str) -> None:
        key = (chat_id, message_id)
        if key not in self._reaction_tokens:
            # Either no reaction was added (no emoji configured or
            # add_reaction failed) or this isn't an inbound we tracked.
            # Either way, no removal call to make. Note: a stored token
            # value of ``None`` is still a valid track — vendors whose
            # remove_reaction works off the message ref alone return
            # None from add_reaction.
            return
        token = self._reaction_tokens.pop(key)
        ref = VendorMessageRef(chat_id=chat_id, message_id=message_id)
        try:
            await self.transport.remove_reaction(ref, token)
        except Exception as exc:
            logger.debug("%s: remove_reaction failed: %s", self.name, exc)

    # ------------------------------------------------------------------
    # Outbound helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _inbound_ref_from_outbound(msg: OutboundMessage) -> VendorMessageRef | None:
        message_id = msg.metadata.get("message_id")
        if message_id is None:
            return None
        return VendorMessageRef(chat_id=msg.chat_id, message_id=str(message_id))

    @staticmethod
    def _thread_id_from_outbound(msg: OutboundMessage) -> str | None:
        thread = msg.metadata.get("message_thread_id")
        return str(thread) if thread is not None else None

    @staticmethod
    def _infer_media_kind(media_path: str) -> str:
        ext = media_path.rsplit(".", 1)[-1].lower() if "." in media_path else ""
        if ext in ("jpg", "jpeg", "png", "gif", "webp"):
            return "photo"
        if ext == "ogg":
            return "voice"
        if ext in ("mp3", "m4a", "wav", "aac"):
            return "audio"
        if ext in ("mp4", "mov", "webm"):
            return "video"
        return "document"

    async def _with_retry(self, fn, *args, **kwargs):
        """Exponential backoff wrapper for any transport call.

        Catches every ``Exception`` so the retry policy is uniform across
        vendor SDKs (each raises its own exception types for timeouts /
        rate limits / network errors). Vendors that need to surface a
        non-retryable error should reraise from inside the transport.
        """
        attempts = max(1, self.profile.send_retries)
        delay = self.profile.send_retry_base_delay
        last_exc: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                return await fn(*args, **kwargs)
            except Exception as exc:
                last_exc = exc
                if attempt == attempts:
                    raise
                logger.warning(
                    "%s: transport call %s failed (attempt %d/%d), retrying in %.1fs: %s",
                    self.name, getattr(fn, "__name__", "?"),
                    attempt, attempts, delay, exc,
                )
                await asyncio.sleep(delay)
                delay *= 2
        # Should be unreachable — final attempt either returns or re-raises.
        assert last_exc is not None
        raise last_exc
