"""Tests for TelegramTransport — the vendor I/O half of TelegramChannel.

Most tests exercise pure module-level helpers (markdown→HTML, command
normalisation, media-extension inference, error classifiers) that don't
need a live bot. The end-to-end test mocks ``python-telegram-bot``'s
``Application`` / ``Bot`` to validate inbound parsing → ChatChannel →
bus and ChatChannel.send → transport → bot API call without spinning up
real polling.
"""

from __future__ import annotations

import pytest

# Skip the whole module when python-telegram-bot isn't installed —
# matches the registry's silent-skip convention for optional channels.
telegram = pytest.importorskip("telegram")

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from app.channels.bus.queue import MessageBus
from app.channels.telegram import (
    TelegramChannel,
    TelegramConfig,
    TelegramTransport,
    _is_not_modified_error,
    _media_extension,
    _normalize_telegram_command,
    _strip_html_tags,
    markdown_to_telegram_html,
    tool_hint_to_telegram_blockquote,
)


# ---------------------------------------------------------------------------
# Module-level pure helpers
# ---------------------------------------------------------------------------


def test_markdown_bold_italic_to_html():
    out = markdown_to_telegram_html("**bold** and _italic_ and ~~strike~~")
    assert "<b>bold</b>" in out
    assert "<i>italic</i>" in out
    assert "<s>strike</s>" in out


def test_markdown_inline_code_escaped_inside_code_tag():
    out = markdown_to_telegram_html("see `<x>`")
    assert "<code>&lt;x&gt;</code>" in out


def test_markdown_code_block_preserved_in_pre_code():
    out = markdown_to_telegram_html("```python\nprint('hi')\n```")
    assert "<pre><code>" in out
    assert "print('hi')" in out


def test_markdown_link_to_anchor():
    out = markdown_to_telegram_html("[OpenYak](https://example.com)")
    assert '<a href="https://example.com">OpenYak</a>' in out


def test_markdown_headers_stripped_to_text():
    out = markdown_to_telegram_html("# Title\n## Sub")
    assert out.startswith("Title")
    assert "Sub" in out
    assert "#" not in out


def test_markdown_bullets_become_dot_prefix():
    out = markdown_to_telegram_html("- one\n- two")
    assert "• one" in out and "• two" in out


def test_markdown_table_renders_as_pre_box():
    out = markdown_to_telegram_html("| h1 | h2 |\n|----|----|\n| a | b |")
    assert "<pre><code>" in out
    # column header survives some form of alignment
    assert "h1" in out and "h2" in out


def test_tool_hint_blockquote_escapes_html():
    out = tool_hint_to_telegram_blockquote("running <thing>")
    assert out == "<blockquote expandable>running &lt;thing&gt;</blockquote>"


def test_tool_hint_blockquote_empty_returns_empty():
    assert tool_hint_to_telegram_blockquote("") == ""


def test_strip_html_tags_keeps_text():
    assert _strip_html_tags("<b>hi</b> there") == "hi there"


def test_normalize_command_underscore_to_dash():
    assert _normalize_telegram_command("/dream_log") == "/dream-log"
    assert _normalize_telegram_command("/dream_log foo") == "/dream-log foo"
    assert _normalize_telegram_command("/dream_restore arg") == "/dream-restore arg"


def test_normalize_command_passthrough_for_other_text():
    assert _normalize_telegram_command("hello") == "hello"
    assert _normalize_telegram_command("/start") == "/start"


def test_media_extension_by_mime():
    assert _media_extension("image", "image/png", None) == ".png"
    assert _media_extension("audio", "audio/mpeg", None) == ".mp3"


def test_media_extension_falls_back_to_filename():
    assert _media_extension(None, None, "report.pdf") == ".pdf"


def test_media_extension_default_image_jpg():
    assert _media_extension("image", None, None) == ".jpg"


def test_is_not_modified_error_detection():
    from telegram.error import BadRequest, NetworkError
    assert _is_not_modified_error(BadRequest("Message is not modified"))
    assert not _is_not_modified_error(BadRequest("Bad request"))
    assert not _is_not_modified_error(NetworkError("timed out"))


# ---------------------------------------------------------------------------
# TelegramChannel — composer wiring
# ---------------------------------------------------------------------------


def test_telegram_channel_uses_chat_channel_machinery():
    bus = MessageBus()
    config = TelegramConfig(token="t", allow_from=["*"], react_emoji="👀")
    channel = TelegramChannel(config, bus)

    from app.channels.chat import ChatChannel
    assert isinstance(channel, ChatChannel)
    assert isinstance(channel.transport, TelegramTransport)
    assert channel.profile.max_message_len == 4000


def test_telegram_extended_allowlist_matches_id_or_username():
    config = TelegramConfig(allow_from=["alice", "12345"])
    channel = TelegramChannel(config, MessageBus())
    # Bare matches via base class
    assert channel.is_allowed("alice")
    assert channel.is_allowed("12345")
    # Composite id|username matches via either half
    assert channel.is_allowed("12345|carol")  # id matches
    assert channel.is_allowed("99999|alice")  # username matches
    # Neither half matches → reject
    assert not channel.is_allowed("99999|carol")
    # Malformed composite → reject
    assert not channel.is_allowed("|alice")
    assert not channel.is_allowed("notdigits|alice")
    assert not channel.is_allowed("12345|")


def test_telegram_channel_supports_streaming_when_configured():
    bus = MessageBus()
    config = TelegramConfig(token="t", allow_from=["*"], streaming=True)
    channel = TelegramChannel(config, bus)
    assert channel.supports_streaming is True

    config2 = TelegramConfig(token="t", allow_from=["*"], streaming=False)
    channel2 = TelegramChannel(config2, bus)
    assert channel2.supports_streaming is False


# ---------------------------------------------------------------------------
# End-to-end: inbound Update → ChatChannel → bus,
#             ChatChannel.send → TelegramTransport → bot.send_message
# ---------------------------------------------------------------------------


def _fake_user(user_id=42, username="alice", first_name="Alice"):
    return SimpleNamespace(
        id=user_id,
        username=username,
        first_name=first_name,
        is_bot=False,
    )


def _fake_message(
    *,
    text="hello bot",
    chat_id=100,
    chat_type="private",
    message_id=7,
    user=None,
    is_forum=False,
    message_thread_id=None,
    media_group_id=None,
    photo=None,
    voice=None,
    audio=None,
    document=None,
    location=None,
    caption=None,
    reply_to_message=None,
):
    chat = SimpleNamespace(id=chat_id, type=chat_type, is_forum=is_forum)
    return SimpleNamespace(
        text=text,
        caption=caption,
        chat=chat,
        chat_id=chat_id,
        message_id=message_id,
        message_thread_id=message_thread_id,
        media_group_id=media_group_id,
        from_user=user,
        photo=photo,
        voice=voice,
        audio=audio,
        document=document,
        location=location,
        reply_to_message=reply_to_message,
        entities=None,
        caption_entities=None,
        reply_text=AsyncMock(),
    )


async def test_e2e_inbound_update_publishes_to_bus_and_send_calls_bot():
    """End-to-end: a fake Telegram Update flows through TelegramTransport
    into ChatChannel onto the bus; an OutboundMessage drained from the bus
    flows back through ChatChannel.send → TelegramTransport →
    bot.send_message."""
    config = TelegramConfig(token="x", allow_from=["*"], react_emoji="", streaming=False)
    bus = MessageBus()
    channel = TelegramChannel(config, bus)

    # Stub the transport's bot client without touching the network.
    bot = MagicMock()
    bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=999))
    bot.send_chat_action = AsyncMock()
    bot.set_message_reaction = AsyncMock()
    app = MagicMock()
    app.bot = bot
    channel.transport._app = app
    channel.transport._bot_user_id = 1
    channel.transport._bot_username = "openyak_bot"
    # Prime the inbound callback as if start() had run.
    channel.transport._on_inbound = channel._handle_inbound_envelope
    channel._running = True

    # Inbound: simulate a private text message
    user = _fake_user(user_id=42, username="alice")
    message = _fake_message(text="hi there", user=user)
    update = SimpleNamespace(
        message=message,
        effective_user=user,
    )
    await channel.transport._on_message(update, ctx=SimpleNamespace())

    inbound = await bus.consume_inbound()
    assert inbound.channel == "telegram"
    assert inbound.sender_id == "42|alice"
    assert inbound.chat_id == "100"
    assert inbound.content == "hi there"

    # Outbound: ChatChannel.send → bot.send_message
    from app.channels.bus.events import OutboundMessage
    await channel.send(OutboundMessage(
        channel="telegram",
        chat_id="100",
        content="reply",
        metadata={"message_id": "7"},
    ))
    assert bot.send_message.await_count == 1
    call = bot.send_message.await_args
    assert call.kwargs["chat_id"] == 100
    assert "reply" in call.kwargs["text"]


async def test_group_open_policy_passes_unmentioned_through_transport():
    """Regression: `group_policy="open"` must accept group messages
    even when they don't @mention the bot or reply to it.

    Background: the transport used to short-circuit non-mentioning
    group messages before constructing a ChatInbound, regardless of
    config — silently breaking deployments that opted into `open`.
    The fix moves the entire policy decision into ChatChannel; the
    transport just translates the vendor event.
    """
    config = TelegramConfig(
        token="x",
        allow_from=["*"],
        react_emoji="",
        streaming=False,
        group_policy="open",
    )
    bus = MessageBus()
    channel = TelegramChannel(config, bus)
    channel.transport._app = MagicMock()
    channel.transport._bot_user_id = 1
    channel.transport._bot_username = "openyak_bot"
    channel.transport._on_inbound = channel._handle_inbound_envelope
    channel._running = True

    user = _fake_user(user_id=42, username="alice")
    # Supergroup message, plain text, no @mention, no reply-to-bot.
    message = _fake_message(
        text="just chatting in the group",
        chat_id=200,
        chat_type="supergroup",
        user=user,
    )
    update = SimpleNamespace(message=message, effective_user=user)
    await channel.transport._on_message(update, ctx=SimpleNamespace())

    inbound = await bus.consume_inbound()
    assert inbound.chat_id == "200"
    assert inbound.content == "just chatting in the group"
    assert inbound.metadata["is_group"] is True


async def test_group_mention_policy_drops_unmentioned_through_transport():
    """Counterpart: `group_policy="mention"` (the default) still drops
    group messages that don't @mention or reply to the bot."""
    config = TelegramConfig(
        token="x",
        allow_from=["*"],
        react_emoji="",
        streaming=False,
        group_policy="mention",
    )
    bus = MessageBus()
    channel = TelegramChannel(config, bus)
    channel.transport._app = MagicMock()
    channel.transport._bot_user_id = 1
    channel.transport._bot_username = "openyak_bot"
    channel.transport._on_inbound = channel._handle_inbound_envelope
    channel._running = True

    user = _fake_user(user_id=42, username="alice")
    message = _fake_message(
        text="just chatting",
        chat_id=300,
        chat_type="supergroup",
        user=user,
    )
    update = SimpleNamespace(message=message, effective_user=user)
    await channel.transport._on_message(update, ctx=SimpleNamespace())

    assert bus.inbound_size == 0


async def test_inbound_command_routed_via_forward_command():
    config = TelegramConfig(token="x", allow_from=["*"], react_emoji="", streaming=False)
    bus = MessageBus()
    channel = TelegramChannel(config, bus)

    channel.transport._on_inbound = channel._handle_inbound_envelope
    channel.transport._app = MagicMock()
    channel._running = True

    user = _fake_user(user_id=42, username="alice")
    message = _fake_message(text="/dream_log foo bar", user=user)
    update = SimpleNamespace(message=message, effective_user=user)
    await channel.transport._forward_command(update, ctx=SimpleNamespace())

    inbound = await bus.consume_inbound()
    # Underscore-style commands are normalised to dash style on the way in.
    assert inbound.content == "/dream-log foo bar"
