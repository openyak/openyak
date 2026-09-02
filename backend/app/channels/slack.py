"""Slack channel — ``ChatChannel`` composer plus Socket Mode transport.

Slack's SDK calls, Socket Mode envelopes, thread timestamps, reactions and
mrkdwn rendering stay in :class:`SlackTransport`. Shared channel policy and
delivery mechanics are provided by :class:`~app.channels.chat.ChatChannel`.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from pydantic import BaseModel, Field
from slack_sdk.socket_mode.request import SocketModeRequest
from slack_sdk.socket_mode.response import SocketModeResponse
from slack_sdk.socket_mode.websockets import SocketModeClient
from slack_sdk.web.async_client import AsyncWebClient
from slackify_markdown import slackify_markdown

from app.channels.bus.queue import MessageBus
from app.channels.chat import (
    ChatChannel,
    ChatInbound,
    ChatProfile,
    MediaKind,
    VendorMessageRef,
)
from app.channels.chat.transport import InboundHandler

logger = logging.getLogger(__name__)


class SlackDMConfig(BaseModel):
    """Slack DM policy configuration."""

    enabled: bool = True
    policy: str = "open"
    allow_from: list[str] = Field(default_factory=list)


class SlackConfig(BaseModel):
    """Slack configuration with the pre-migration field names intact."""

    enabled: bool = False
    mode: str = "socket"
    webhook_path: str = "/slack/events"
    bot_token: str = ""
    app_token: str = ""
    user_token_read_only: bool = True
    reply_in_thread: bool = True
    react_emoji: str = "eyes"
    done_emoji: str = "white_check_mark"
    allow_from: list[str] = Field(default_factory=list)
    group_policy: str = "mention"
    group_allow_from: list[str] = Field(default_factory=list)
    dm: SlackDMConfig = Field(default_factory=SlackDMConfig)


class SlackTransport:
    """Slack-specific I/O backed by ``slack_sdk`` Socket Mode."""

    name = "slack"

    _TABLE_RE = re.compile(r"(?m)^\|.*\|$(?:\n\|[\s:|-]*\|$)(?:\n\|.*\|$)*")
    _CODE_FENCE_RE = re.compile(r"```[\s\S]*?```")
    _INLINE_CODE_RE = re.compile(r"`[^`]+`")
    _LEFTOVER_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
    _LEFTOVER_HEADER_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
    _BARE_URL_RE = re.compile(r"(?<![|<])(https?://\S+)")

    def __init__(self, config: SlackConfig) -> None:
        self.config = config
        self._web_client: AsyncWebClient | None = None
        self._socket_client: SocketModeClient | None = None
        self._bot_user_id: str | None = None
        self._on_inbound: InboundHandler | None = None
        self._running = False
        # Inbound event ts -> thread destination. AgentAdapter preserves the
        # event ts in OutboundMessage.reply_to, letting the transport restore
        # the Slack thread without exposing that concept to ChatChannel.
        self._reply_threads: dict[tuple[str, str], str | None] = {}

    async def start(self, on_inbound: InboundHandler) -> None:
        if not self.config.bot_token or not self.config.app_token:
            logger.error("Slack bot/app token not configured")
            return
        if self.config.mode != "socket":
            logger.error("Unsupported Slack mode: %s", self.config.mode)
            return

        self._on_inbound = on_inbound
        self._running = True
        self._web_client = AsyncWebClient(token=self.config.bot_token)
        self._socket_client = SocketModeClient(
            app_token=self.config.app_token,
            web_client=self._web_client,
        )
        self._socket_client.socket_mode_request_listeners.append(self._on_socket_request)

        try:
            auth = await self._web_client.auth_test()
            self._bot_user_id = auth.get("user_id")
            logger.info("Slack bot connected as %s", self._bot_user_id)
        except Exception as exc:
            logger.warning("Slack auth_test failed: %s", exc)

        logger.info("Starting Slack Socket Mode client...")
        await self._socket_client.connect()
        while self._running:
            await asyncio.sleep(1)

    async def stop(self) -> None:
        self._running = False
        if self._socket_client:
            try:
                await self._socket_client.close()
            except Exception as exc:
                logger.warning("Slack socket close failed: %s", exc)
        self._socket_client = None
        self._web_client = None
        self._on_inbound = None
        self._reply_threads.clear()

    async def send_text(
        self,
        chat_id: str,
        text: str,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef:
        client = self._require_client()
        thread_ts = self._resolve_thread(chat_id, reply_to, thread_id)
        response = await client.chat_postMessage(
            channel=chat_id,
            text=text or " ",
            thread_ts=thread_ts,
        )
        return VendorMessageRef(
            chat_id=chat_id,
            message_id=str(response.get("ts") or ""),
            extra={"thread_ts": thread_ts},
        )

    async def edit_text(self, ref: VendorMessageRef, text: str) -> None:
        client = self._require_client()
        await client.chat_update(channel=ref.chat_id, ts=ref.message_id, text=text or " ")

    async def send_media(
        self,
        chat_id: str,
        media_path: str,
        kind: MediaKind,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef | None:
        del kind  # Slack infers media type from the uploaded file.
        client = self._require_client()
        thread_ts = self._resolve_thread(chat_id, reply_to, thread_id)
        response = await client.files_upload_v2(
            channel=chat_id,
            file=media_path,
            thread_ts=thread_ts,
        )
        file_info = response.get("file") or {}
        message_id = file_info.get("id") if isinstance(file_info, dict) else None
        return (
            VendorMessageRef(chat_id=chat_id, message_id=str(message_id))
            if message_id else None
        )

    async def show_typing(self, chat_id: str) -> None:
        # Slack does not expose a bot typing-indicator API.
        del chat_id

    async def add_reaction(self, ref: VendorMessageRef, emoji: str) -> str:
        client = self._require_client()
        await client.reactions_add(
            channel=ref.chat_id,
            name=emoji,
            timestamp=ref.message_id,
        )
        return emoji

    async def remove_reaction(self, ref: VendorMessageRef, token: Any) -> None:
        client = self._require_client()
        try:
            await client.reactions_remove(
                channel=ref.chat_id,
                name=str(token or self.config.react_emoji),
                timestamp=ref.message_id,
            )
        except Exception as exc:
            logger.debug("Slack reactions_remove failed: %s", exc)
        if self.config.done_emoji:
            try:
                await client.reactions_add(
                    channel=ref.chat_id,
                    name=self.config.done_emoji,
                    timestamp=ref.message_id,
                )
            except Exception as exc:
                logger.debug("Slack done reaction failed: %s", exc)

    def render_text(self, markdown: str) -> str:
        if markdown == " ":
            return markdown
        return self._to_mrkdwn(markdown)

    def render_quote(self, text: str) -> str:
        rendered = self._to_mrkdwn(text)
        return "\n".join(f"> {line}" for line in rendered.splitlines())

    async def _on_socket_request(
        self,
        client: SocketModeClient,
        req: SocketModeRequest,
    ) -> None:
        """Acknowledge and translate one Socket Mode envelope."""
        if req.type != "events_api":
            return
        await client.send_socket_mode_response(
            SocketModeResponse(envelope_id=req.envelope_id)
        )

        event = ((req.payload or {}).get("event") or {})
        event_type = event.get("type")
        if event_type not in ("message", "app_mention"):
            return
        sender_id = event.get("user")
        chat_id = event.get("channel")
        if event.get("subtype") or not sender_id or not chat_id:
            return
        if self._bot_user_id and sender_id == self._bot_user_id:
            return

        text = event.get("text") or ""
        mentioned = bool(self._bot_user_id and f"<@{self._bot_user_id}>" in text)
        # Slack emits both message and app_mention for the same mention.
        if event_type == "message" and mentioned:
            return

        channel_type = event.get("channel_type") or ""
        if not self._is_allowed(sender_id, chat_id, channel_type):
            return
        if channel_type != "im" and not self._should_respond_in_channel(
            event_type, text, chat_id
        ):
            return

        message_id = str(event.get("ts") or "")
        if not message_id:
            return
        thread_ts = event.get("thread_ts")
        if self.config.reply_in_thread and not thread_ts:
            thread_ts = event.get("ts")
        if channel_type == "im":
            thread_ts = None
        self._reply_threads[(str(chat_id), message_id)] = (
            str(thread_ts) if thread_ts else None
        )

        admitted_group = self.config.group_policy in ("open", "allowlist")
        metadata = {
            "message_id": message_id,
            "message_thread_id": str(thread_ts) if thread_ts else None,
            "slack": {
                "event": event,
                "thread_ts": thread_ts,
                "channel_type": channel_type,
            },
        }
        envelope = ChatInbound(
            sender_id=str(sender_id),
            chat_id=str(chat_id),
            content=self._strip_bot_mention(text),
            message_ref=VendorMessageRef(
                chat_id=str(chat_id),
                message_id=message_id,
                extra={"thread_ts": thread_ts, "channel_type": channel_type},
            ),
            is_group=channel_type != "im",
            is_mention_to_bot=(event_type == "app_mention" or mentioned or admitted_group),
            thread_id=str(thread_ts) if thread_ts else None,
            session_key=(
                f"slack:{chat_id}:{thread_ts}"
                if thread_ts and channel_type != "im" else None
            ),
            metadata=metadata,
        )
        if self._on_inbound is None:
            return
        try:
            await self._on_inbound(envelope)
        except Exception:
            logger.exception("Error handling Slack message from %s", sender_id)

    def _require_client(self) -> AsyncWebClient:
        if self._web_client is None:
            raise RuntimeError("SlackTransport not started")
        return self._web_client

    def _resolve_thread(
        self,
        chat_id: str,
        reply_to: VendorMessageRef | None,
        thread_id: str | None,
    ) -> str | None:
        if thread_id:
            return str(thread_id)
        if reply_to is None:
            return None
        return self._reply_threads.get((str(chat_id), str(reply_to.message_id)))

    def _is_allowed(self, sender_id: str, chat_id: str, channel_type: str) -> bool:
        if channel_type == "im":
            if not self.config.dm.enabled:
                return False
            if self.config.dm.policy == "allowlist":
                return sender_id in self.config.dm.allow_from
            return True
        if self.config.group_policy == "allowlist":
            return chat_id in self.config.group_allow_from
        return True

    def _should_respond_in_channel(
        self,
        event_type: str,
        text: str,
        chat_id: str,
    ) -> bool:
        if self.config.group_policy == "open":
            return True
        if self.config.group_policy == "mention":
            return event_type == "app_mention" or bool(
                self._bot_user_id and f"<@{self._bot_user_id}>" in text
            )
        if self.config.group_policy == "allowlist":
            return chat_id in self.config.group_allow_from
        return False

    def _strip_bot_mention(self, text: str) -> str:
        if not text or not self._bot_user_id:
            return text
        return re.sub(rf"<@{re.escape(self._bot_user_id)}>\s*", "", text).strip()

    @classmethod
    def _to_mrkdwn(cls, text: str) -> str:
        if not text:
            return ""
        text = cls._TABLE_RE.sub(cls._convert_table, text)
        return cls._fixup_mrkdwn(slackify_markdown(text))

    @classmethod
    def _fixup_mrkdwn(cls, text: str) -> str:
        code_blocks: list[str] = []

        def _save_code(match: re.Match) -> str:
            code_blocks.append(match.group(0))
            return f"\x00CB{len(code_blocks) - 1}\x00"

        text = cls._CODE_FENCE_RE.sub(_save_code, text)
        text = cls._INLINE_CODE_RE.sub(_save_code, text)
        text = cls._LEFTOVER_BOLD_RE.sub(r"*\1*", text)
        text = cls._LEFTOVER_HEADER_RE.sub(r"*\1*", text)
        text = cls._BARE_URL_RE.sub(
            lambda match: match.group(0).replace("&amp;", "&"), text
        )
        for index, block in enumerate(code_blocks):
            text = text.replace(f"\x00CB{index}\x00", block)
        return text

    @staticmethod
    def _convert_table(match: re.Match) -> str:
        lines = [line.strip() for line in match.group(0).strip().splitlines() if line.strip()]
        if len(lines) < 2:
            return match.group(0)
        headers = [header.strip() for header in lines[0].strip("|").split("|")]
        start = 2 if re.fullmatch(r"[|\s:\-]+", lines[1]) else 1
        rows: list[str] = []
        for line in lines[start:]:
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            cells = (cells + [""] * len(headers))[: len(headers)]
            parts = [
                f"**{headers[index]}**: {cells[index]}"
                for index in range(len(headers)) if cells[index]
            ]
            if parts:
                rows.append(" · ".join(parts))
        return "\n".join(rows)


def _slack_profile() -> ChatProfile:
    return ChatProfile(
        max_message_len=40_000,
        media_group_buffer_ms=0,
        typing_indicator_interval=0,
        supports_edit=False,
        empty_message_fallback=" ",
    )


class SlackChannel(ChatChannel):
    """Thin Slack composer over :class:`ChatChannel`."""

    name = "slack"
    display_name = "Slack"

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return SlackConfig().model_dump(by_alias=True)

    def __init__(self, config: Any, bus: MessageBus) -> None:
        if isinstance(config, dict):
            config = SlackConfig.model_validate(config)
        transport = SlackTransport(config)
        super().__init__(config, bus, transport=transport, profile=_slack_profile())
        self.config: SlackConfig = config

    def is_allowed(self, sender_id: str) -> bool:
        """Accept envelopes already vetted against Slack's contextual policy.

        Slack has separate DM-user and group-channel allowlists; evaluating
        them from a sender id alone would change existing configuration
        semantics. SlackTransport rejects disallowed envelopes first.
        """
        del sender_id
        return True

    # Keep the old private rendering entry point available to local callers.
    _to_mrkdwn = SlackTransport._to_mrkdwn
