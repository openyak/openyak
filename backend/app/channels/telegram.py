"""Telegram channel — composer over :class:`ChatChannel` + :class:`TelegramTransport` (ADR-0006).

Vendor-specific I/O lives in :class:`TelegramTransport`: long-poll
lifecycle, send / edit / upload through ``python-telegram-bot``,
markdown→HTML rendering, mention parsing, media download. The shared
scaffolding (allowlist, group policy, streaming buffer, media-group
coalescing, typing loop, retry, lifecycle) is inherited from
:class:`ChatChannel`.

The Channel class itself is intentionally thin — it only exists to
override the ``name`` / ``display_name`` attributes for routing, extend
:meth:`is_allowed` with Telegram's legacy ``id|username`` matching, and
build a ``TelegramTransport`` + ``ChatProfile`` from
:class:`TelegramConfig`.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field
from telegram import BotCommand, ReactionTypeEmoji, ReplyParameters, Update
from telegram.error import BadRequest, NetworkError, TimedOut
from telegram.ext import Application, ContextTypes, MessageHandler, filters
from telegram.request import HTTPXRequest

from app.channels.bus.queue import MessageBus
from app.channels.chat import (
    ChatChannel,
    ChatInbound,
    ChatProfile,
    MediaKind,
    NonRetryableTransportError,
    VendorMessageRef,
)
from app.channels.chat.transport import InboundHandler
from app.channels.helpers import build_help_text, get_media_dir, validate_url_target

logger = logging.getLogger(__name__)


TELEGRAM_MAX_MESSAGE_LEN = 4000


# ---------------------------------------------------------------------------
# Markdown → Telegram HTML
# ---------------------------------------------------------------------------


def _escape_telegram_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _strip_md(s: str) -> str:
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"__(.+?)__", r"\1", s)
    s = re.sub(r"~~(.+?)~~", r"\1", s)
    s = re.sub(r"`([^`]+)`", r"\1", s)
    return s.strip()


def _render_table_box(table_lines: list[str]) -> str:
    """Convert a markdown pipe-table to compact aligned text for ``<pre>``."""

    def dw(s: str) -> int:
        return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in s)

    rows: list[list[str]] = []
    has_sep = False
    for line in table_lines:
        cells = [_strip_md(c) for c in line.strip().strip("|").split("|")]
        if all(re.match(r"^:?-+:?$", c) for c in cells if c):
            has_sep = True
            continue
        rows.append(cells)
    if not rows or not has_sep:
        return "\n".join(table_lines)

    ncols = max(len(r) for r in rows)
    for r in rows:
        r.extend([""] * (ncols - len(r)))
    widths = [max(dw(r[c]) for r in rows) for c in range(ncols)]

    def dr(cells: list[str]) -> str:
        return "  ".join(f'{c}{" " * (w - dw(c))}' for c, w in zip(cells, widths))

    out = [dr(rows[0])]
    out.append("  ".join("─" * w for w in widths))
    for row in rows[1:]:
        out.append(dr(row))
    return "\n".join(out)


def markdown_to_telegram_html(text: str) -> str:
    """Translate generic markdown into Telegram-safe HTML.

    Telegram's HTML mode supports a fixed tag set (``b / i / u / s /
    code / pre / a / blockquote``); anything else has to be flattened
    or escaped. This function preserves code blocks and inline code
    verbatim, renders tables as box-drawing inside ``<pre>``, and
    escapes the rest before applying inline formatting tags.
    """
    if not text:
        return ""

    code_blocks: list[str] = []

    def save_code_block(m: re.Match) -> str:
        code_blocks.append(m.group(1))
        return f"\x00CB{len(code_blocks) - 1}\x00"

    text = re.sub(r"```[\w]*\n?([\s\S]*?)```", save_code_block, text)

    lines = text.split("\n")
    rebuilt: list[str] = []
    li = 0
    while li < len(lines):
        if re.match(r"^\s*\|.+\|", lines[li]):
            tbl: list[str] = []
            while li < len(lines) and re.match(r"^\s*\|.+\|", lines[li]):
                tbl.append(lines[li])
                li += 1
            box = _render_table_box(tbl)
            if box != "\n".join(tbl):
                code_blocks.append(box)
                rebuilt.append(f"\x00CB{len(code_blocks) - 1}\x00")
            else:
                rebuilt.extend(tbl)
        else:
            rebuilt.append(lines[li])
            li += 1
    text = "\n".join(rebuilt)

    inline_codes: list[str] = []

    def save_inline_code(m: re.Match) -> str:
        inline_codes.append(m.group(1))
        return f"\x00IC{len(inline_codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", save_inline_code, text)
    text = re.sub(r"^#{1,6}\s+(.+)$", r"\1", text, flags=re.MULTILINE)
    text = re.sub(r"^>\s*(.*)$", r"\1", text, flags=re.MULTILINE)
    text = _escape_telegram_html(text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"__(.+?)__", r"<b>\1</b>", text)
    text = re.sub(r"(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])", r"<i>\1</i>", text)
    text = re.sub(r"~~(.+?)~~", r"<s>\1</s>", text)
    text = re.sub(r"^[-*]\s+", "• ", text, flags=re.MULTILINE)

    for i, code in enumerate(inline_codes):
        escaped = _escape_telegram_html(code)
        text = text.replace(f"\x00IC{i}\x00", f"<code>{escaped}</code>")
    for i, code in enumerate(code_blocks):
        escaped = _escape_telegram_html(code)
        text = text.replace(f"\x00CB{i}\x00", f"<pre><code>{escaped}</code></pre>")

    return text


def tool_hint_to_telegram_blockquote(text: str) -> str:
    return f"<blockquote expandable>{_escape_telegram_html(text)}</blockquote>" if text else ""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class TelegramConfig(BaseModel):
    """Telegram channel configuration. Pydantic model."""

    enabled: bool = False
    token: str = ""
    allow_from: list[str] = Field(default_factory=list)
    proxy: str | None = None
    reply_to_message: bool = False
    react_emoji: str = "👀"
    group_policy: Literal["open", "mention"] = "mention"
    connection_pool_size: int = 32
    pool_timeout: float = 5.0
    streaming: bool = True
    stream_edit_interval: float = Field(default=0.6, ge=0.1)


# ---------------------------------------------------------------------------
# TelegramTransport — vendor I/O
# ---------------------------------------------------------------------------


_BOT_COMMANDS = [
    BotCommand("start", "Start the bot"),
    BotCommand("new", "Start a new conversation"),
    BotCommand("stop", "Stop the current task"),
    BotCommand("restart", "Restart the bot"),
    BotCommand("status", "Show bot status"),
    BotCommand("dream", "Run Dream memory consolidation now"),
    BotCommand("dream_log", "Show the latest Dream memory change"),
    BotCommand("dream_restore", "Restore Dream memory to an earlier version"),
    BotCommand("help", "Show available commands"),
]


class TelegramTransport:
    """Implements :class:`VendorTransport` against ``python-telegram-bot``."""

    name = "telegram"

    def __init__(self, config: TelegramConfig) -> None:
        self.config = config
        self._app: Application | None = None
        self._on_inbound: InboundHandler | None = None
        self._bot_user_id: int | None = None
        self._bot_username: str | None = None
        # Cache thread context per (chat_id, message_id) so outbound
        # replies to a topic-rooted message land in the same topic.
        self._message_threads: dict[tuple[str, int], int] = {}

    # ---- Lifecycle -------------------------------------------------

    async def start(self, on_inbound: InboundHandler) -> None:
        if not self.config.token:
            logger.error("Telegram bot token not configured")
            return
        self._on_inbound = on_inbound

        proxy = self.config.proxy or None
        api_request = HTTPXRequest(
            connection_pool_size=self.config.connection_pool_size,
            pool_timeout=self.config.pool_timeout,
            connect_timeout=30.0,
            read_timeout=30.0,
            proxy=proxy,
        )
        poll_request = HTTPXRequest(
            connection_pool_size=4,
            pool_timeout=self.config.pool_timeout,
            connect_timeout=30.0,
            read_timeout=30.0,
            proxy=proxy,
        )
        self._app = (
            Application.builder()
            .token(self.config.token)
            .request(api_request)
            .get_updates_request(poll_request)
            .build()
        )
        self._app.add_error_handler(self._on_error)

        self._app.add_handler(MessageHandler(filters.Regex(r"^/start(?:@\w+)?$"), self._on_start))
        self._app.add_handler(MessageHandler(
            filters.Regex(r"^/(new|stop|restart|status|dream)(?:@\w+)?(?:\s+.*)?$"),
            self._forward_command,
        ))
        self._app.add_handler(MessageHandler(
            filters.Regex(r"^/(dream-log|dream_log|dream-restore|dream_restore)(?:@\w+)?(?:\s+.*)?$"),
            self._forward_command,
        ))
        self._app.add_handler(MessageHandler(filters.Regex(r"^/help(?:@\w+)?$"), self._on_help))
        self._app.add_handler(MessageHandler(
            (filters.TEXT | filters.PHOTO | filters.VOICE | filters.AUDIO | filters.Document.ALL | filters.LOCATION)
            & ~filters.COMMAND,
            self._on_message,
        ))

        await self._app.initialize()
        await self._app.start()

        bot_info = await self._app.bot.get_me()
        self._bot_user_id = getattr(bot_info, "id", None)
        self._bot_username = getattr(bot_info, "username", None)
        logger.info("Telegram bot @%s connected", bot_info.username)

        try:
            await self._app.bot.set_my_commands(_BOT_COMMANDS)
            logger.debug("Telegram bot commands registered")
        except Exception as e:
            logger.warning("Failed to register bot commands: %s", e)

        await self._app.updater.start_polling(
            allowed_updates=["message"],
            drop_pending_updates=False,
            error_callback=self._on_polling_error,
        )

    async def stop(self) -> None:
        if not self._app:
            return
        logger.info("Stopping Telegram bot...")
        try:
            await self._app.updater.stop()
            await self._app.stop()
            await self._app.shutdown()
        finally:
            self._app = None
            self._on_inbound = None

    # ---- Outbound -------------------------------------------------

    async def send_text(
        self,
        chat_id: str,
        text: str,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef:
        if not self._app:
            raise RuntimeError("TelegramTransport not started")
        thread_kwargs = self._thread_kwargs(chat_id, reply_to, thread_id)
        reply_params = self._reply_parameters(reply_to)
        try:
            sent = await self._app.bot.send_message(
                chat_id=int(chat_id),
                text=text,
                parse_mode="HTML",
                reply_parameters=reply_params,
                **thread_kwargs,
            )
        except BadRequest as e:
            # Fall back to plain text on HTML parse failure — surfaces
            # for content with malformed tags. Network errors are not
            # caught here; ChatChannel's _with_retry will retry them.
            logger.warning("HTML parse failed, falling back to plain text: %s", e)
            sent = await self._app.bot.send_message(
                chat_id=int(chat_id),
                text=_strip_html_tags(text),
                reply_parameters=reply_params,
                **thread_kwargs,
            )
        return VendorMessageRef(chat_id=chat_id, message_id=str(sent.message_id))

    async def edit_text(
        self,
        ref: VendorMessageRef,
        text: str,
    ) -> None:
        if not self._app:
            raise RuntimeError("TelegramTransport not started")
        try:
            await self._app.bot.edit_message_text(
                chat_id=int(ref.chat_id),
                message_id=int(ref.message_id),
                text=text,
                parse_mode="HTML",
            )
        except BadRequest as e:
            if _is_not_modified_error(e):
                # The body is already what we want — equivalent to
                # success. Don't surface as an error to the channel.
                return
            # HTML parse failure: try plain
            logger.debug("HTML edit failed (%s), retrying plain", e)
            try:
                await self._app.bot.edit_message_text(
                    chat_id=int(ref.chat_id),
                    message_id=int(ref.message_id),
                    text=_strip_html_tags(text),
                )
            except BadRequest as e2:
                if _is_not_modified_error(e2):
                    return
                # Plain edit also failed with a 400 — vendor says this
                # message can't be edited (e.g. message deleted, content
                # identical after parse-strip). Don't burn retry budget.
                raise NonRetryableTransportError(str(e2)) from e2

    async def send_media(
        self,
        chat_id: str,
        media_path: str,
        kind: MediaKind,
        *,
        reply_to: VendorMessageRef | None = None,
        thread_id: str | None = None,
    ) -> VendorMessageRef | None:
        if not self._app:
            raise RuntimeError("TelegramTransport not started")
        thread_kwargs = self._thread_kwargs(chat_id, reply_to, thread_id)
        reply_params = self._reply_parameters(reply_to)
        sender_map = {
            "photo": (self._app.bot.send_photo, "photo"),
            "voice": (self._app.bot.send_voice, "voice"),
            "audio": (self._app.bot.send_audio, "audio"),
        }
        sender, param = sender_map.get(kind, (self._app.bot.send_document, "document"))

        if media_path.startswith(("http://", "https://")):
            ok, error = validate_url_target(media_path)
            if not ok:
                raise NonRetryableTransportError(f"unsafe media URL: {error}")
            sent = await sender(
                chat_id=int(chat_id),
                **{param: media_path},
                reply_parameters=reply_params,
                **thread_kwargs,
            )
        else:
            with open(media_path, "rb") as f:
                sent = await sender(
                    chat_id=int(chat_id),
                    **{param: f},
                    reply_parameters=reply_params,
                    **thread_kwargs,
                )
        msg_id = getattr(sent, "message_id", None)
        return VendorMessageRef(chat_id=chat_id, message_id=str(msg_id)) if msg_id else None

    # ---- UX feedback ---------------------------------------------

    async def show_typing(self, chat_id: str) -> None:
        if not self._app:
            return
        await self._app.bot.send_chat_action(chat_id=int(chat_id), action="typing")

    async def add_reaction(
        self,
        ref: VendorMessageRef,
        emoji: str,
    ) -> Any:
        if not self._app or not emoji:
            return None
        try:
            await self._app.bot.set_message_reaction(
                chat_id=int(ref.chat_id),
                message_id=int(ref.message_id),
                reaction=[ReactionTypeEmoji(emoji=emoji)],
            )
        except Exception as e:
            logger.debug("Telegram reaction failed: %s", e)
        # Telegram identifies reactions by (chat, message) — no opaque
        # token needed for removal. Return None.
        return None

    async def remove_reaction(
        self,
        ref: VendorMessageRef,
        token: Any,
    ) -> None:
        if not self._app:
            return
        try:
            await self._app.bot.set_message_reaction(
                chat_id=int(ref.chat_id),
                message_id=int(ref.message_id),
                reaction=[],
            )
        except Exception as e:
            logger.debug("Telegram reaction removal failed: %s", e)

    # ---- Rendering -----------------------------------------------

    def render_text(self, markdown: str) -> str:
        return markdown_to_telegram_html(markdown)

    def render_quote(self, text: str) -> str:
        return tool_hint_to_telegram_blockquote(text)

    # ---- Inbound parsing -----------------------------------------

    async def _on_message(self, update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.message or not update.effective_user or self._on_inbound is None:
            return
        message = update.message
        user = update.effective_user
        self._remember_thread_context(message)

        # Group-policy gating happens at ChatChannel — the transport's
        # job is to translate vendor events into ChatInbound envelopes
        # with `is_group` / `is_mention_to_bot` / `is_reply_to_bot`
        # populated correctly. ChatChannel reads `config.group_policy`
        # and decides whether to drop or dispatch.

        content_parts: list[str] = []
        media_paths: list[str] = []
        if message.text:
            content_parts.append(message.text)
        if message.caption:
            content_parts.append(message.caption)
        if message.location:
            content_parts.append(
                f"[location: {message.location.latitude}, {message.location.longitude}]"
            )

        current_media, current_parts = await self._download_message_media(
            message, add_failure_content=True
        )
        media_paths.extend(current_media)
        content_parts.extend(current_parts)

        reply = getattr(message, "reply_to_message", None)
        if reply is not None:
            reply_ctx = await self._extract_reply_context(message)
            reply_media, reply_parts = await self._download_message_media(reply)
            if reply_media:
                media_paths = reply_media + media_paths
            tag = reply_ctx or (f"[Reply to: {reply_parts[0]}]" if reply_parts else None)
            if tag:
                content_parts.insert(0, tag)
        content = "\n".join(content_parts) if content_parts else "[empty message]"

        env = ChatInbound(
            sender_id=self._sender_id(user),
            chat_id=str(message.chat_id),
            content=content,
            message_ref=VendorMessageRef(
                chat_id=str(message.chat_id),
                message_id=str(message.message_id),
            ),
            media=media_paths,
            is_group=message.chat.type != "private",
            is_mention_to_bot=await self._is_mentioned(message),
            is_reply_to_bot=self._is_reply_to_bot(message),
            media_group_id=getattr(message, "media_group_id", None),
            thread_id=str(getattr(message, "message_thread_id", "") or "") or None,
            session_key=self._derive_topic_session_key(message),
            metadata=self._build_message_metadata(message, user),
        )
        await self._on_inbound(env)

    async def _forward_command(self, update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.message or not update.effective_user or self._on_inbound is None:
            return
        message = update.message
        user = update.effective_user
        self._remember_thread_context(message)

        content = message.text or ""
        if content.startswith("/") and "@" in content:
            cmd_part, *rest = content.split(" ", 1)
            cmd_part = cmd_part.split("@")[0]
            content = f"{cmd_part} {rest[0]}" if rest else cmd_part
        content = _normalize_telegram_command(content)

        env = ChatInbound(
            sender_id=self._sender_id(user),
            chat_id=str(message.chat_id),
            content=content,
            message_ref=VendorMessageRef(
                chat_id=str(message.chat_id),
                message_id=str(message.message_id),
            ),
            is_group=message.chat.type != "private",
            session_key=self._derive_topic_session_key(message),
            metadata=self._build_message_metadata(message, user),
        )
        await self._on_inbound(env)

    async def _on_start(self, update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.message or not update.effective_user:
            return
        user = update.effective_user
        await update.message.reply_text(
            f"👋 Hi {user.first_name}! I'm nanobot.\n\n"
            "Send me a message and I'll respond!\n"
            "Type /help to see available commands."
        )

    async def _on_help(self, update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.message:
            return
        await update.message.reply_text(build_help_text())

    # ---- Inbound helpers -----------------------------------------

    @staticmethod
    def _sender_id(user) -> str:
        sid = str(user.id)
        return f"{sid}|{user.username}" if user.username else sid

    @staticmethod
    def _derive_topic_session_key(message) -> str | None:
        thread_id = getattr(message, "message_thread_id", None)
        if thread_id is None:
            return None
        return f"telegram:{message.chat_id}:topic:{thread_id}"

    @staticmethod
    def _build_message_metadata(message, user) -> dict[str, Any]:
        reply_to = getattr(message, "reply_to_message", None)
        return {
            "message_id": message.message_id,
            "user_id": user.id,
            "username": user.username,
            "first_name": user.first_name,
            "is_group": message.chat.type != "private",
            "message_thread_id": getattr(message, "message_thread_id", None),
            "is_forum": bool(getattr(message.chat, "is_forum", False)),
            "reply_to_message_id": getattr(reply_to, "message_id", None) if reply_to else None,
        }

    def _remember_thread_context(self, message) -> None:
        thread_id = getattr(message, "message_thread_id", None)
        if thread_id is None:
            return
        key = (str(message.chat_id), message.message_id)
        self._message_threads[key] = thread_id
        if len(self._message_threads) > 1000:
            self._message_threads.pop(next(iter(self._message_threads)))

    async def _ensure_bot_identity(self) -> tuple[int | None, str | None]:
        if self._bot_user_id is not None or self._bot_username is not None:
            return self._bot_user_id, self._bot_username
        if not self._app:
            return None, None
        bot_info = await self._app.bot.get_me()
        self._bot_user_id = getattr(bot_info, "id", None)
        self._bot_username = getattr(bot_info, "username", None)
        return self._bot_user_id, self._bot_username

    @staticmethod
    def _has_mention_entity(text, entities, bot_username, bot_id) -> bool:
        handle = f"@{bot_username}".lower()
        for entity in entities or []:
            etype = getattr(entity, "type", None)
            if etype == "text_mention":
                u = getattr(entity, "user", None)
                if u is not None and bot_id is not None and getattr(u, "id", None) == bot_id:
                    return True
                continue
            if etype != "mention":
                continue
            offset = getattr(entity, "offset", None)
            length = getattr(entity, "length", None)
            if offset is None or length is None:
                continue
            if text[offset : offset + length].lower() == handle:
                return True
        return handle in text.lower()

    async def _is_mentioned(self, message) -> bool:
        bot_id, bot_username = await self._ensure_bot_identity()
        if not bot_username:
            return False
        text = message.text or ""
        caption = message.caption or ""
        if self._has_mention_entity(text, getattr(message, "entities", None), bot_username, bot_id):
            return True
        return self._has_mention_entity(caption, getattr(message, "caption_entities", None), bot_username, bot_id)

    def _is_reply_to_bot(self, message) -> bool:
        reply_user = getattr(getattr(message, "reply_to_message", None), "from_user", None)
        return bool(self._bot_user_id and reply_user and reply_user.id == self._bot_user_id)

    async def _extract_reply_context(self, message) -> str | None:
        reply = getattr(message, "reply_to_message", None)
        if not reply:
            return None
        text = getattr(reply, "text", None) or getattr(reply, "caption", None) or ""
        if len(text) > TELEGRAM_MAX_MESSAGE_LEN:
            text = text[:TELEGRAM_MAX_MESSAGE_LEN] + "..."
        if not text:
            return None
        bot_id, _ = await self._ensure_bot_identity()
        reply_user = getattr(reply, "from_user", None)
        if bot_id and reply_user and getattr(reply_user, "id", None) == bot_id:
            return f"[Reply to bot: {text}]"
        if reply_user and getattr(reply_user, "username", None):
            return f"[Reply to @{reply_user.username}: {text}]"
        if reply_user and getattr(reply_user, "first_name", None):
            return f"[Reply to {reply_user.first_name}: {text}]"
        return f"[Reply to: {text}]"

    async def _download_message_media(
        self,
        msg,
        *,
        add_failure_content: bool = False,
    ) -> tuple[list[str], list[str]]:
        media_file = None
        media_type = None
        if getattr(msg, "photo", None):
            media_file = msg.photo[-1]
            media_type = "image"
        elif getattr(msg, "voice", None):
            media_file, media_type = msg.voice, "voice"
        elif getattr(msg, "audio", None):
            media_file, media_type = msg.audio, "audio"
        elif getattr(msg, "document", None):
            media_file, media_type = msg.document, "file"
        elif getattr(msg, "video", None):
            media_file, media_type = msg.video, "video"
        elif getattr(msg, "video_note", None):
            media_file, media_type = msg.video_note, "video"
        elif getattr(msg, "animation", None):
            media_file, media_type = msg.animation, "animation"
        if not media_file or not self._app:
            return [], []
        try:
            file = await self._app.bot.get_file(media_file.file_id)
            ext = _media_extension(
                media_type,
                getattr(media_file, "mime_type", None),
                getattr(media_file, "file_name", None),
            )
            media_dir = get_media_dir("telegram")
            unique_id = getattr(media_file, "file_unique_id", media_file.file_id)
            file_path = media_dir / f"{unique_id}{ext}"
            await file.download_to_drive(str(file_path))
            path_str = str(file_path)
            return [path_str], [f"[{media_type}: {path_str}]"]
        except Exception as e:
            logger.warning("Failed to download message media: %s", e)
            if add_failure_content:
                return [], [f"[{media_type}: download failed]"]
            return [], []

    # ---- Outbound helpers ----------------------------------------

    def _thread_kwargs(
        self,
        chat_id: str,
        reply_to: VendorMessageRef | None,
        thread_id: str | None,
    ) -> dict[str, Any]:
        if thread_id is None and reply_to is not None:
            cached = self._message_threads.get((chat_id, int(reply_to.message_id)))
            if cached is not None:
                thread_id = str(cached)
        if thread_id is None:
            return {}
        try:
            return {"message_thread_id": int(thread_id)}
        except (TypeError, ValueError):
            return {}

    def _reply_parameters(self, reply_to: VendorMessageRef | None) -> ReplyParameters | None:
        if reply_to is None or not self.config.reply_to_message:
            return None
        try:
            return ReplyParameters(
                message_id=int(reply_to.message_id),
                allow_sending_without_reply=True,
            )
        except (TypeError, ValueError):
            return None

    # ---- Error handlers ------------------------------------------

    def _on_polling_error(self, exc: Exception) -> None:
        summary = _format_telegram_error(exc)
        if isinstance(exc, (NetworkError, TimedOut)):
            logger.warning("Telegram polling network issue: %s", summary)
        else:
            logger.error("Telegram polling error: %s", summary)

    async def _on_error(self, update: object, ctx: ContextTypes.DEFAULT_TYPE) -> None:
        summary = _format_telegram_error(ctx.error)
        if isinstance(ctx.error, (NetworkError, TimedOut)):
            logger.warning("Telegram network issue: %s", summary)
        else:
            logger.error("Telegram error: %s", summary)


# ---------------------------------------------------------------------------
# Module-level helpers (pure)
# ---------------------------------------------------------------------------


def _normalize_telegram_command(content: str) -> str:
    if not content.startswith("/"):
        return content
    if content == "/dream_log" or content.startswith("/dream_log "):
        return content.replace("/dream_log", "/dream-log", 1)
    if content == "/dream_restore" or content.startswith("/dream_restore "):
        return content.replace("/dream_restore", "/dream-restore", 1)
    return content


def _is_not_modified_error(exc: Exception) -> bool:
    return isinstance(exc, BadRequest) and "message is not modified" in str(exc).lower()


def _strip_html_tags(text: str) -> str:
    """Quick fallback when Telegram rejects HTML — strip tags for a
    plain-text retry. Only meant for malformed-HTML recovery; not a
    full HTML-to-text renderer."""
    return re.sub(r"<[^>]+>", "", text)


def _format_telegram_error(exc: Exception) -> str:
    text = str(exc).strip()
    if text:
        return text
    if exc.__cause__ is not None:
        cause = exc.__cause__
        cause_text = str(cause).strip()
        if cause_text:
            return f"{exc.__class__.__name__} ({cause_text})"
        return f"{exc.__class__.__name__} ({cause.__class__.__name__})"
    return exc.__class__.__name__


def _media_extension(
    media_type: str | None,
    mime_type: str | None,
    filename: str | None,
) -> str:
    if mime_type:
        ext_map = {
            "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
            "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
        }
        if mime_type in ext_map:
            return ext_map[mime_type]
    type_map = {"image": ".jpg", "voice": ".ogg", "audio": ".mp3", "file": ""}
    if ext := type_map.get(media_type or "", ""):
        return ext
    if filename:
        return "".join(Path(filename).suffixes)
    return ""


# ---------------------------------------------------------------------------
# TelegramChannel — composer
# ---------------------------------------------------------------------------


def _telegram_profile(config: TelegramConfig) -> ChatProfile:
    return ChatProfile(
        max_message_len=TELEGRAM_MAX_MESSAGE_LEN,
        stream_edit_interval=config.stream_edit_interval,
        media_group_buffer_ms=600,
        typing_indicator_interval=4.0,
        send_retries=3,
        send_retry_base_delay=0.5,
        supports_edit=True,
    )


class TelegramChannel(ChatChannel):
    """Thin :class:`ChatChannel` over :class:`TelegramTransport`.

    All scaffolding (allowlist, group policy, streaming, media group,
    typing, retry) inherited from :class:`ChatChannel`. Telegram-specific
    behaviours kept here:

    - ``is_allowed`` extension matching ``id|username`` composite senders
      against either the id or the username (legacy allowlist shape).
    - ``default_config`` exposing :class:`TelegramConfig` for onboarding.
    """

    name = "telegram"
    display_name = "Telegram"

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return TelegramConfig().model_dump(by_alias=True)

    def __init__(self, config: Any, bus: MessageBus) -> None:
        if isinstance(config, dict):
            config = TelegramConfig.model_validate(config)
        transport = TelegramTransport(config)
        super().__init__(
            config=config,
            bus=bus,
            transport=transport,
            profile=_telegram_profile(config),
        )
        self.config: TelegramConfig = config

    def is_allowed(self, sender_id: str) -> bool:
        """Match either the bare id or the ``id|username`` composite."""
        if super().is_allowed(sender_id):
            return True

        allow_list = self.config.allow_from
        if not allow_list or "*" in allow_list:
            return False

        sender_str = str(sender_id)
        if sender_str.count("|") != 1:
            return False
        sid, username = sender_str.split("|", 1)
        if not sid.isdigit() or not username:
            return False
        return sid in allow_list or username in allow_list
