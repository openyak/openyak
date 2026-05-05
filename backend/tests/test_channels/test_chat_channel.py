"""Scaffolding tests for ChatChannel via RecordingTransport.

Each test exercises one piece of the eight-piece scaffolding identified
in ADR-0006 (allowlist + group policy, reactions, typing, media-group
buffer, streaming buffer, text chunking, retry, lifecycle). The
RecordingTransport stands in for any real vendor SDK.
"""

from __future__ import annotations

import dataclasses
from types import SimpleNamespace

import pytest

from app.channels.bus.events import OutboundMessage
from app.channels.bus.queue import MessageBus
from app.channels.chat import (
    ChatChannel,
    ChatInbound,
    ChatProfile,
    NonRetryableTransportError,
    RecordingTransport,
    VendorMessageRef,
)


pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_config(
    *,
    allow_from=("alice",),
    group_policy="mention",
    streaming=True,
    react_emoji="👀",
):
    return SimpleNamespace(
        allow_from=list(allow_from),
        group_policy=group_policy,
        streaming=streaming,
        react_emoji=react_emoji,
    )


def _make_profile(**overrides):
    base = dict(
        max_message_len=20,
        stream_edit_interval=0.0,  # tests don't want to wait
        media_group_buffer_ms=50,
        typing_indicator_interval=0.0,  # disable by default; tests opt in
        send_retries=2,
        send_retry_base_delay=0.0,
    )
    base.update(overrides)
    return ChatProfile(**base)


def _make_channel(*, config=None, profile=None, transport=None):
    bus = MessageBus()
    transport = transport or RecordingTransport()
    profile = profile or _make_profile()
    config = config or _make_config()
    return ChatChannel(
        config=config,
        bus=bus,
        transport=transport,
        profile=profile,
    ), bus, transport


def _inbound(
    *,
    sender="alice",
    chat="chat-1",
    content="hi",
    media=(),
    is_group=False,
    mention=False,
    reply_bot=False,
    media_group_id=None,
    message_id="100",
    metadata=None,
    session_key=None,
):
    return ChatInbound(
        sender_id=sender,
        chat_id=chat,
        content=content,
        message_ref=VendorMessageRef(chat_id=chat, message_id=message_id),
        media=list(media),
        is_group=is_group,
        is_mention_to_bot=mention,
        is_reply_to_bot=reply_bot,
        media_group_id=media_group_id,
        metadata=dict(metadata or {"message_id": message_id}),
        session_key=session_key,
    )


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def test_start_stop_delegates_to_transport():
    channel, _, transport = _make_channel()
    await channel.start()
    assert transport.started is True
    assert transport.methods_called() == ["start"]
    await channel.stop()
    assert transport.stopped is True
    assert "stop" in transport.methods_called()


async def test_stop_cancels_typing_tasks():
    profile = _make_profile(typing_indicator_interval=10)
    channel, _, transport = _make_channel(profile=profile)
    await channel.start()
    channel._start_typing("c-1")
    assert "c-1" in channel._typing_tasks
    await channel.stop()
    assert channel._typing_tasks == {}


# ---------------------------------------------------------------------------
# Allowlist + group policy
# ---------------------------------------------------------------------------


async def test_allowlist_blocks_unknown_sender():
    channel, bus, transport = _make_channel()
    await channel.start()
    await transport.push_inbound(_inbound(sender="mallory"))
    assert bus.inbound_size == 0
    # No reaction either — the message was dropped before side effects.
    assert "add_reaction" not in transport.methods_called()


async def test_group_mention_policy_drops_unmentioned():
    channel, bus, transport = _make_channel()
    await channel.start()
    await transport.push_inbound(_inbound(is_group=True, mention=False))
    assert bus.inbound_size == 0


async def test_group_mention_policy_passes_mentioned():
    channel, bus, transport = _make_channel()
    await channel.start()
    await transport.push_inbound(_inbound(is_group=True, mention=True))
    assert bus.inbound_size == 1


async def test_group_open_policy_passes_unmentioned():
    config = _make_config(group_policy="open")
    channel, bus, transport = _make_channel(config=config)
    await channel.start()
    await transport.push_inbound(_inbound(is_group=True, mention=False))
    assert bus.inbound_size == 1


async def test_group_reply_to_bot_passes():
    channel, bus, transport = _make_channel()
    await channel.start()
    await transport.push_inbound(_inbound(is_group=True, reply_bot=True))
    assert bus.inbound_size == 1


async def test_wildcard_allowlist_lets_anyone_in():
    config = _make_config(allow_from=["*"])
    channel, bus, transport = _make_channel(config=config)
    await channel.start()
    await transport.push_inbound(_inbound(sender="random-user"))
    assert bus.inbound_size == 1


# ---------------------------------------------------------------------------
# Reactions
# ---------------------------------------------------------------------------


async def test_reaction_added_on_inbound_and_removed_on_send():
    channel, _, transport = _make_channel()
    await channel.start()
    await transport.push_inbound(_inbound(message_id="42"))
    assert ("chat-1", "42") in transport.outstanding_reactions

    await channel.send(OutboundMessage(
        channel="base", chat_id="chat-1", content="response",
        metadata={"message_id": "42"},
    ))
    assert ("chat-1", "42") not in transport.outstanding_reactions
    assert "remove_reaction" in transport.methods_called()


async def test_reaction_not_removed_for_progress_messages():
    channel, _, transport = _make_channel()
    await channel.start()
    await transport.push_inbound(_inbound(message_id="42"))

    await channel.send(OutboundMessage(
        channel="base", chat_id="chat-1", content="thinking...",
        metadata={"message_id": "42", "_progress": True},
    ))
    assert ("chat-1", "42") in transport.outstanding_reactions


async def test_reaction_skipped_when_no_emoji_configured():
    config = _make_config(react_emoji=None)
    channel, _, transport = _make_channel(config=config)
    await channel.start()
    await transport.push_inbound(_inbound())
    assert "add_reaction" not in transport.methods_called()


# ---------------------------------------------------------------------------
# Media-group buffering
# ---------------------------------------------------------------------------


async def test_media_group_coalesces_into_single_dispatch():
    profile = _make_profile(media_group_buffer_ms=10)
    channel, bus, transport = _make_channel(profile=profile)
    await channel.start()

    # Three album items sharing a media_group_id
    for i in range(3):
        await transport.push_inbound(_inbound(
            content=f"caption-{i}" if i == 0 else "",
            media=[f"/tmp/img-{i}.jpg"],
            media_group_id="album-A",
            message_id=str(100 + i),
        ))

    # Drain the specific flush task instead of sleeping past a wallclock
    # window — keeps the test stable on loaded CI.
    flush_task = next(iter(channel._media_group_tasks.values()))
    await flush_task

    assert bus.inbound_size == 1
    msg = await bus.consume_inbound()
    assert msg.content == "caption-0"
    assert msg.media == ["/tmp/img-0.jpg", "/tmp/img-1.jpg", "/tmp/img-2.jpg"]
    # Only the first event triggered the inbound reaction.
    add_reactions = [c for c in transport.calls if c.method == "add_reaction"]
    assert len(add_reactions) == 1


# ---------------------------------------------------------------------------
# Outbound — chunking, media, reply/thread, render
# ---------------------------------------------------------------------------


async def test_outbound_text_chunked_when_over_max_len():
    profile = _make_profile(max_message_len=10)
    channel, _, transport = _make_channel(profile=profile)
    await channel.start()

    long_text = "abcdefghij" * 4  # 40 chars / max 10
    await channel.send(OutboundMessage(
        channel="base", chat_id="c-9", content=long_text, metadata={},
    ))
    sends = [c for c in transport.calls if c.method == "send_text"]
    assert len(sends) == 4
    for s in sends:
        assert len(s.kwargs["text"]) <= 10


async def test_outbound_media_dispatched_with_inferred_kind():
    channel, _, transport = _make_channel()
    await channel.start()

    await channel.send(OutboundMessage(
        channel="base", chat_id="c-1", content="",
        media=["/tmp/x.jpg", "/tmp/x.ogg", "/tmp/x.bin"],
        metadata={},
    ))
    media_calls = [c for c in transport.calls if c.method == "send_media"]
    assert [c.kwargs["kind"] for c in media_calls] == ["photo", "voice", "document"]


async def test_outbound_propagates_reply_and_thread():
    channel, _, transport = _make_channel()
    await channel.start()

    await channel.send(OutboundMessage(
        channel="base", chat_id="c-1", content="hi",
        metadata={"message_id": "55", "message_thread_id": "topic-9"},
    ))
    send = next(c for c in transport.calls if c.method == "send_text")
    assert send.kwargs["reply_to"] == VendorMessageRef(chat_id="c-1", message_id="55")
    assert send.kwargs["thread_id"] == "topic-9"


async def test_tool_hint_uses_render_quote():
    transport = RecordingTransport(render_quote_prefix="QUOTE> ")
    channel, _, transport = _make_channel(transport=transport)
    await channel.start()

    await channel.send(OutboundMessage(
        channel="base", chat_id="c-1", content="Running tool foo",
        metadata={"_tool_hint": True},
    ))
    send = next(c for c in transport.calls if c.method == "send_text")
    assert send.kwargs["text"].startswith("QUOTE> ")


# ---------------------------------------------------------------------------
# Streaming buffer
# ---------------------------------------------------------------------------


async def test_streaming_first_delta_sends_then_subsequent_edits():
    channel, _, transport = _make_channel()
    await channel.start()

    await channel.send_delta("c-1", "hello", metadata={"_stream_id": "s1"})
    await channel.send_delta("c-1", " world", metadata={"_stream_id": "s1"})

    sends = [c for c in transport.calls if c.method == "send_text"]
    edits = [c for c in transport.calls if c.method == "edit_text"]
    assert len(sends) == 1
    assert len(edits) == 1
    # Edit carries the accumulated text, not just the delta.
    assert "hello world" in edits[0].kwargs["text"]


async def test_streaming_throttles_edits():
    profile = _make_profile(stream_edit_interval=10.0)  # never expires within test
    channel, _, transport = _make_channel(profile=profile)
    await channel.start()

    await channel.send_delta("c-1", "a", metadata={"_stream_id": "s1"})
    await channel.send_delta("c-1", "b", metadata={"_stream_id": "s1"})
    await channel.send_delta("c-1", "c", metadata={"_stream_id": "s1"})

    edits = [c for c in transport.calls if c.method == "edit_text"]
    assert edits == []  # throttled out


async def test_streaming_end_finalises_with_full_text():
    channel, _, transport = _make_channel()
    await channel.start()

    await channel.send_delta("c-1", "partial", metadata={"_stream_id": "s1"})
    await channel.send_delta("c-1", "", metadata={"_stream_id": "s1", "_stream_end": True})

    edits = [c for c in transport.calls if c.method == "edit_text"]
    # Two edits: throttled-bypass from second delta, then final from end.
    final_edit = edits[-1]
    assert "partial" in final_edit.kwargs["text"]
    assert "c-1" not in channel._stream_bufs


async def test_streaming_end_with_overlong_text_chunks_remainder():
    """End-of-stream with text > max_message_len edits the streamed
    message in place (first chunk) and sends the rest as follow-ups."""
    profile = _make_profile(max_message_len=5, stream_edit_interval=0.0)
    channel, _, transport = _make_channel(profile=profile)
    await channel.start()

    await channel.send_delta("c-1", "abcdefghij", metadata={"_stream_id": "s1"})
    await channel.send_delta("c-1", "", metadata={"_stream_id": "s1", "_stream_end": True})

    sends = [c for c in transport.calls if c.method == "send_text"]
    edits = [c for c in transport.calls if c.method == "edit_text"]
    # 1 initial send_text on first delta; ≥1 edit_text on end (final
    # edit places the first chunk); 1 send_text per overflow chunk.
    assert len(sends) == 2  # initial + 1 overflow
    assert len(edits) >= 1


async def test_streaming_end_skips_finalisation_when_buffer_is_whitespace():
    """Whitespace-only buffers (e.g. the model emitted only padding)
    must not trigger a final edit_text — most vendors reject empty/
    whitespace text on edit and the channel would surface a transport
    error for what is really a no-op."""
    channel, _, transport = _make_channel()
    await channel.start()

    # Force the buffer state without going through the (whitespace-
    # rejecting) send_delta happy path.
    from app.channels.chat.channel import _StreamBuf
    channel._stream_bufs["c-1"] = _StreamBuf(
        text="   \n  ",
        ref=VendorMessageRef(chat_id="c-1", message_id="42"),
        stream_id="s1",
    )
    await channel.send_delta("c-1", "", metadata={"_stream_id": "s1", "_stream_end": True})

    edits = [c for c in transport.calls if c.method == "edit_text"]
    assert edits == []


# ---------------------------------------------------------------------------
# Retry
# ---------------------------------------------------------------------------


async def test_send_retries_then_succeeds():
    transport = RecordingTransport()
    transport.fail_next("send_text", RuntimeError("boom"))
    channel, _, _ = _make_channel(transport=transport)
    await channel.start()

    await channel.send(OutboundMessage(
        channel="base", chat_id="c-1", content="hi", metadata={},
    ))
    sends = [c for c in transport.calls if c.method == "send_text"]
    assert len(sends) == 2  # first failed, second succeeded


async def test_send_retries_exhaust_and_raise():
    profile = _make_profile(send_retries=2)
    transport = RecordingTransport()
    transport.fail_next("send_text", RuntimeError("boom-1"))
    transport.fail_next("send_text", RuntimeError("boom-2"))

    channel, _, _ = _make_channel(profile=profile, transport=transport)
    await channel.start()

    with pytest.raises(RuntimeError, match="boom-2"):
        await channel.send(OutboundMessage(
            channel="base", chat_id="c-1", content="hi", metadata={},
        ))


async def test_non_retryable_error_skips_retry_loop():
    """A NonRetryableTransportError is re-raised immediately without
    burning the remaining attempt budget."""
    profile = _make_profile(send_retries=5)
    transport = RecordingTransport()
    transport.fail_next("send_text", NonRetryableTransportError("permanent"))

    channel, _, _ = _make_channel(profile=profile, transport=transport)
    await channel.start()

    with pytest.raises(NonRetryableTransportError, match="permanent"):
        await channel.send(OutboundMessage(
            channel="base", chat_id="c-1", content="hi", metadata={},
        ))
    sends = [c for c in transport.calls if c.method == "send_text"]
    assert len(sends) == 1


# ---------------------------------------------------------------------------
# Typing indicator
# ---------------------------------------------------------------------------


async def test_typing_loop_continues_through_transient_failure():
    """A single show_typing failure must not silence the indicator
    permanently — the loop continues on the next interval."""
    profile = _make_profile(typing_indicator_interval=0.01)
    transport = RecordingTransport()
    # Fail once, then subsequent calls succeed.
    transport.fail_next("show_typing", RuntimeError("transient"))

    channel, _, _ = _make_channel(profile=profile, transport=transport)
    await channel.start()
    channel._start_typing("c-1")

    # Let the loop iterate enough times to retry past the failure.
    import asyncio as _asyncio
    await _asyncio.sleep(0.05)
    channel._stop_typing("c-1")

    typings = [c for c in transport.calls if c.method == "show_typing"]
    assert len(typings) >= 2  # one failed, one or more succeeded


# ---------------------------------------------------------------------------
# supports_streaming wiring
# ---------------------------------------------------------------------------


async def test_supports_streaming_requires_config_and_profile():
    # config.streaming=False
    channel, _, _ = _make_channel(config=_make_config(streaming=False))
    assert channel.supports_streaming is False

    # profile.supports_edit=False
    no_edit_profile = dataclasses.replace(_make_profile(), supports_edit=False)
    channel, _, _ = _make_channel(profile=no_edit_profile)
    assert channel.supports_streaming is False

    # both true
    channel, _, _ = _make_channel()
    assert channel.supports_streaming is True


async def test_streaming_metadata_injected_into_inbound():
    channel, bus, transport = _make_channel()
    await channel.start()

    await transport.push_inbound(_inbound())
    msg = await bus.consume_inbound()
    assert msg.metadata.get("_wants_stream") is True
