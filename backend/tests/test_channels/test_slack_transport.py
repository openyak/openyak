"""SlackTransport contract and SlackChannel composition tests."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

pytest.importorskip("slack_sdk")
pytest.importorskip("slackify_markdown")

from app.channels.bus.events import OutboundMessage
from app.channels.bus.queue import MessageBus
from app.channels.chat import ChatChannel, VendorMessageRef, VendorTransport
from app.channels.slack import SlackChannel, SlackConfig, SlackTransport


def _request(event: dict, *, envelope_id: str = "env-1") -> SimpleNamespace:
    return SimpleNamespace(
        type="events_api",
        envelope_id=envelope_id,
        payload={"event": event},
    )


def _wire_channel(config: SlackConfig) -> tuple[SlackChannel, MessageBus, MagicMock, MagicMock]:
    bus = MessageBus()
    channel = SlackChannel(config, bus)
    web = MagicMock()
    web.chat_postMessage = AsyncMock(return_value={"ts": "200.1"})
    web.chat_update = AsyncMock()
    web.files_upload_v2 = AsyncMock(return_value={"file": {"id": "F1"}})
    web.reactions_add = AsyncMock()
    web.reactions_remove = AsyncMock()
    socket = MagicMock()
    socket.send_socket_mode_response = AsyncMock()
    channel.transport._web_client = web
    channel.transport._bot_user_id = "B1"
    channel.transport._on_inbound = channel._handle_inbound_envelope
    channel._running = True
    return channel, bus, web, socket


def test_slack_channel_is_chat_channel_with_vendor_transport():
    channel = SlackChannel(SlackConfig(), MessageBus())
    assert isinstance(channel, ChatChannel)
    assert isinstance(channel.transport, SlackTransport)
    assert isinstance(channel.transport, VendorTransport)
    assert channel.profile.max_message_len == 40_000
    assert channel.profile.media_group_buffer_ms == 0


def test_slack_config_keys_are_unchanged():
    config = SlackChannel.default_config()
    assert set(config) == {
        "enabled", "mode", "webhook_path", "bot_token", "app_token",
        "user_token_read_only", "reply_in_thread", "react_emoji",
        "done_emoji", "allow_from", "group_policy", "group_allow_from", "dm",
    }


@pytest.mark.asyncio
async def test_dm_inbound_and_outbound_preserve_reply_and_reactions():
    channel, bus, web, socket = _wire_channel(SlackConfig())
    event = {
        "type": "message",
        "user": "U1",
        "channel": "D1",
        "channel_type": "im",
        "text": "hello",
        "ts": "100.1",
    }

    await channel.transport._on_socket_request(socket, _request(event))

    inbound = await bus.consume_inbound()
    assert inbound.channel == "slack"
    assert inbound.sender_id == "U1"
    assert inbound.chat_id == "D1"
    assert inbound.content == "hello"
    assert inbound.metadata["message_id"] == "100.1"
    assert inbound.session_key == "slack:D1"
    socket.send_socket_mode_response.assert_awaited_once()
    web.reactions_add.assert_awaited_once_with(
        channel="D1", name="eyes", timestamp="100.1"
    )

    await channel.send(OutboundMessage(
        channel="slack",
        chat_id="D1",
        content="**reply**",
        reply_to="100.1",
    ))

    web.reactions_remove.assert_awaited_once_with(
        channel="D1", name="eyes", timestamp="100.1"
    )
    assert web.reactions_add.await_args_list[-1].kwargs["name"] == "white_check_mark"
    post = web.chat_postMessage.await_args.kwargs
    assert post["channel"] == "D1"
    assert post["thread_ts"] is None
    assert "reply" in post["text"]


@pytest.mark.asyncio
async def test_channel_mention_restores_thread_from_reply_to_contract():
    channel, bus, web, socket = _wire_channel(SlackConfig(group_policy="mention"))
    event = {
        "type": "app_mention",
        "user": "U1",
        "channel": "C1",
        "channel_type": "channel",
        "text": "<@B1> help",
        "ts": "100.2",
    }

    await channel.transport._on_socket_request(socket, _request(event))
    inbound = await bus.consume_inbound()
    assert inbound.content == "help"
    assert inbound.session_key == "slack:C1:100.2"

    await channel.send(OutboundMessage(
        channel="slack", chat_id="C1", content="answer", reply_to="100.2",
    ))
    assert web.chat_postMessage.await_args.kwargs["thread_ts"] == "100.2"


@pytest.mark.asyncio
async def test_dm_allowlist_is_kept_inside_transport():
    config = SlackConfig(dm={"enabled": True, "policy": "allowlist", "allow_from": ["U2"]})
    channel, bus, _, socket = _wire_channel(config)
    event = {
        "type": "message", "user": "U1", "channel": "D1",
        "channel_type": "im", "text": "blocked", "ts": "100.3",
    }
    await channel.transport._on_socket_request(socket, _request(event))
    assert bus.inbound_size == 0
    socket.send_socket_mode_response.assert_awaited_once()


@pytest.mark.asyncio
async def test_group_allowlist_accepts_unmentioned_message_in_allowed_channel():
    config = SlackConfig(group_policy="allowlist", group_allow_from=["C1"])
    channel, bus, _, socket = _wire_channel(config)
    event = {
        "type": "message", "user": "U1", "channel": "C1",
        "channel_type": "channel", "text": "allowed", "ts": "100.4",
    }
    await channel.transport._on_socket_request(socket, _request(event))
    inbound = await bus.consume_inbound()
    assert inbound.content == "allowed"


@pytest.mark.asyncio
async def test_send_media_uses_cached_thread():
    config = SlackConfig()
    transport = SlackTransport(config)
    web = MagicMock()
    web.files_upload_v2 = AsyncMock(return_value={"file": {"id": "F1"}})
    transport._web_client = web
    transport._reply_threads[("C1", "100.5")] = "99.1"

    ref = await transport.send_media(
        "C1",
        "/tmp/report.pdf",
        "document",
        reply_to=VendorMessageRef(chat_id="C1", message_id="100.5"),
    )
    assert ref == VendorMessageRef(chat_id="C1", message_id="F1")
    assert web.files_upload_v2.await_args.kwargs["thread_ts"] == "99.1"


@pytest.mark.asyncio
async def test_empty_outbound_keeps_legacy_blank_message_contract():
    channel, _, web, _ = _wire_channel(SlackConfig())
    await channel.send(OutboundMessage(channel="slack", chat_id="D1", content=""))
    assert web.chat_postMessage.await_args.kwargs["text"] == " "


def test_slack_markdown_table_is_rendered_as_readable_rows():
    rendered = SlackTransport(SlackConfig()).render_text(
        "| Name | State |\n| --- | --- |\n| OpenYak | active |"
    )
    assert "Name" in rendered
    assert "OpenYak" in rendered
    assert "active" in rendered
