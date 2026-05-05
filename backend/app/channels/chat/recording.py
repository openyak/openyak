"""``RecordingTransport`` — in-memory test adapter for :class:`ChatChannel`.

Records every call into ``calls`` so tests can assert exactly which
transport methods fired, in what order, with what arguments. Lets tests
inject inbound events through :meth:`push_inbound` to drive the
Channel's policy logic. Supports failure injection through
:meth:`fail_next` for testing the retry path.

Designed for unit tests only — never wired into a real Channel manager.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.channels.chat.transport import (
    ChatInbound,
    InboundHandler,
    MediaKind,
    VendorMessageRef,
)


@dataclass
class RecordedCall:
    """One captured invocation of a :class:`RecordingTransport` method."""

    method: str
    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = field(default_factory=dict)


class RecordingTransport:
    """In-memory :class:`VendorTransport`. Pure record + replay."""

    name: str = "recording"

    def __init__(
        self,
        *,
        render_text_prefix: str = "",
        render_quote_prefix: str = "[QUOTE] ",
    ) -> None:
        self.calls: list[RecordedCall] = []
        self._on_inbound: InboundHandler | None = None
        self._next_message_id = 1
        self._reaction_id = 1
        self._render_text_prefix = render_text_prefix
        self._render_quote_prefix = render_quote_prefix
        # Failure injection: pop the head before each method call; if
        # the head matches the method name, raise the configured error.
        self._fail_queue: list[tuple[str, Exception]] = []
        # Per-(chat, message_id) reaction tokens issued by add_reaction.
        # Tests can introspect to verify lifecycle.
        self.outstanding_reactions: dict[tuple[str, str], Any] = {}
        self.started = False
        self.stopped = False

    # ---- Test-side API --------------------------------------------

    async def push_inbound(self, env: ChatInbound) -> None:
        """Drive the Channel's inbound pipeline as if the vendor had
        produced this event."""
        if self._on_inbound is None:
            raise RuntimeError("Transport not started; no inbound handler registered.")
        await self._on_inbound(env)

    def fail_next(self, method: str, exc: Exception) -> None:
        """Make the next call to ``method`` raise ``exc``. Queueable —
        call repeatedly to inject multiple failures."""
        self._fail_queue.append((method, exc))

    def _maybe_fail(self, method: str) -> None:
        if not self._fail_queue:
            return
        head_method, head_exc = self._fail_queue[0]
        if head_method == method:
            self._fail_queue.pop(0)
            raise head_exc

    def _record(self, method: str, *args: Any, **kwargs: Any) -> None:
        self.calls.append(RecordedCall(method=method, args=args, kwargs=kwargs))

    def methods_called(self) -> list[str]:
        return [c.method for c in self.calls]

    # ---- VendorTransport implementation ---------------------------

    async def start(self, on_inbound: InboundHandler) -> None:
        self._record("start")
        self._on_inbound = on_inbound
        self.started = True

    async def stop(self) -> None:
        self._record("stop")
        self._on_inbound = None
        self.stopped = True

    async def send_text(
        self,
        chat_id: str,
        text: str,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef:
        self._record("send_text", chat_id=chat_id, text=text, reply_to=reply_to, thread_id=thread_id)
        self._maybe_fail("send_text")
        ref = VendorMessageRef(
            chat_id=chat_id,
            message_id=str(self._next_message_id),
        )
        self._next_message_id += 1
        return ref

    async def edit_text(
        self,
        ref: VendorMessageRef,
        text: str,
    ) -> None:
        self._record("edit_text", ref=ref, text=text)
        self._maybe_fail("edit_text")

    async def send_media(
        self,
        chat_id: str,
        media_path: str,
        kind: MediaKind,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef | None:
        self._record(
            "send_media",
            chat_id=chat_id, media_path=media_path, kind=kind,
            reply_to=reply_to, thread_id=thread_id,
        )
        self._maybe_fail("send_media")
        ref = VendorMessageRef(chat_id=chat_id, message_id=str(self._next_message_id))
        self._next_message_id += 1
        return ref

    async def show_typing(self, chat_id: str) -> None:
        self._record("show_typing", chat_id=chat_id)
        self._maybe_fail("show_typing")

    async def add_reaction(
        self,
        ref: VendorMessageRef,
        emoji: str,
    ) -> Any:
        self._record("add_reaction", ref=ref, emoji=emoji)
        self._maybe_fail("add_reaction")
        token = f"reaction-{self._reaction_id}"
        self._reaction_id += 1
        self.outstanding_reactions[(ref.chat_id, ref.message_id)] = token
        return token

    async def remove_reaction(
        self,
        ref: VendorMessageRef,
        token: Any,
    ) -> None:
        self._record("remove_reaction", ref=ref, token=token)
        self._maybe_fail("remove_reaction")
        self.outstanding_reactions.pop((ref.chat_id, ref.message_id), None)

    def render_text(self, markdown: str) -> str:
        return self._render_text_prefix + markdown

    def render_quote(self, text: str) -> str:
        return self._render_quote_prefix + text
