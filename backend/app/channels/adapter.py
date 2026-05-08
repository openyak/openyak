"""OpenYak agent adapter — bridges the message bus to OpenYak's generation pipeline.

Replaces nanobot's AgentLoop: consumes InboundMessage from the bus,
runs OpenYak's full agent (run_generation), and publishes OutboundMessage.
"""

from __future__ import annotations

import asyncio
import functools
import logging
from typing import Any

from app.channels.bus.events import InboundMessage, OutboundMessage
from app.channels.bus.queue import MessageBus

logger = logging.getLogger(__name__)

# Max concurrent agent tasks across all sessions
_MAX_CONCURRENT = 3


class AgentAdapter:
    """Consumes messages from the bus and runs OpenYak's agent pipeline.

    Manages per-session serialization and cross-session concurrency.
    """

    def __init__(self, bus: MessageBus, app_state: Any):
        self.bus = bus
        self.app_state = app_state
        self._running = False
        self._task: asyncio.Task | None = None
        self._semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
        self._session_locks: dict[str, asyncio.Lock] = {}

    async def start(self) -> None:
        """Start the adapter loop."""
        self._running = True
        self._task = asyncio.create_task(self._run(), name="channel-agent-adapter")
        logger.info("Channel agent adapter started")

    async def stop(self) -> None:
        """Stop the adapter loop."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Channel agent adapter stopped")

    async def _run(self) -> None:
        """Main loop: consume inbound messages and dispatch to agent."""
        while self._running:
            try:
                msg = await asyncio.wait_for(
                    self.bus.consume_inbound(),
                    timeout=1.0,
                )
                asyncio.create_task(
                    self._handle(msg),
                    name=f"channel-msg-{msg.channel}:{msg.chat_id}",
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Agent adapter error: %s", e, exc_info=True)
                await asyncio.sleep(1)

    async def _handle(self, msg: InboundMessage) -> None:
        """Process a single inbound message through OpenYak's agent."""
        session_key = msg.session_key

        # Per-session lock ensures serial processing
        if session_key not in self._session_locks:
            self._session_locks[session_key] = asyncio.Lock()

        async with self._session_locks[session_key]:
            await self._semaphore.acquire()
            try:
                response_text = await self._call_agent(msg)
            except Exception as e:
                logger.error("Agent generation failed for %s: %s", session_key, e, exc_info=True)
                response_text = f"Sorry, an error occurred: {type(e).__name__}"
            finally:
                self._semaphore.release()

        # Publish response
        await self.bus.publish_outbound(OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=response_text,
            reply_to=msg.metadata.get("message_id"),
        ))

    async def _call_agent(self, msg: InboundMessage) -> str:
        """Call OpenYak's run_generation pipeline and collect the response text."""
        # Lazy imports to avoid circular dependencies at module level
        from app.dependencies import (
            get_agent_registry,
            get_index_manager,
            get_provider_registry,
            get_session_factory,
            get_stream_manager,
            get_tool_registry,
        )
        from app.schemas.chat import PromptRequest
        from app.session.manager import create_session
        from app.session.processor import run_generation
        from app.streaming.events import AGENT_ERROR, DONE, TEXT_DELTA
        from app.utils.id import generate_ulid

        session_factory = get_session_factory()
        provider_registry = get_provider_registry()
        agent_registry = get_agent_registry()
        tool_registry = get_tool_registry()
        index_manager = get_index_manager()
        stream_manager = get_stream_manager()

        # Resolve or create session for this channel user
        session_id = await self._get_or_create_session(
            session_factory, msg.session_key, msg.sender_id,
        )

        stream_id = generate_ulid()
        job = stream_manager.create_job(stream_id=stream_id, session_id=session_id)
        job.interactive = False  # Auto-approve permissions in headless mode

        # Pick the best available model
        model_id = self._resolve_best_model(provider_registry)

        prompt = PromptRequest(
            session_id=session_id,
            text=msg.content,
            agent="build",
            model=model_id,
        )

        logger.info(
            "Channel %s [%s]: generating response (model=%s)",
            msg.channel, msg.chat_id, model_id,
        )

        # Run generation
        coro = run_generation(
            job,
            prompt,
            session_factory=session_factory,
            provider_registry=provider_registry,
            agent_registry=agent_registry,
            tool_registry=tool_registry,
            index_manager=index_manager,
        )

        task = asyncio.create_task(coro, name=f"gen-channel-{stream_id}")
        job.task = task

        # Collect response from SSE events
        queue = job.subscribe()
        text_parts: list[str] = []

        # If channel wants streaming, publish deltas as they come
        wants_stream = msg.metadata.get("_wants_stream", False)

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=300)
            except asyncio.TimeoutError:
                text_parts.append("\n[Response timed out]")
                break

            if event is None:
                break

            if event.event == TEXT_DELTA:
                text = event.data.get("text", "")
                if text:
                    text_parts.append(text)
                    if wants_stream:
                        await self.bus.publish_outbound(OutboundMessage(
                            channel=msg.channel,
                            chat_id=msg.chat_id,
                            content=text,
                            metadata={"_stream_delta": True},
                        ))
            elif event.event == DONE:
                if wants_stream:
                    await self.bus.publish_outbound(OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content="",
                        metadata={"_stream_delta": True, "_stream_end": True, "_streamed": True},
                    ))
                break
            elif event.event == AGENT_ERROR:
                error_msg = event.data.get("error_message", "Unknown error")
                text_parts.append(f"\n[Error: {error_msg}]")
                break

        full_text = "".join(text_parts)

        # If we streamed, mark the final OutboundMessage so manager skips the full send
        if wants_stream:
            return ""  # Already sent via deltas

        return full_text or "[No response generated]"

    @staticmethod
    async def _get_or_create_session(session_factory, channel_user_key: str, sender_id: str) -> str:
        """Find existing session for a channel user or create a new one."""
        from app.models.session import Session
        from app.session.manager import create_session
        from sqlalchemy import select

        async with session_factory() as db:
            stmt = (
                select(Session)
                .where(Session.slug == channel_user_key, Session.parent_id.is_(None))
                .order_by(Session.time_created.desc())
                .limit(1)
            )
            result = await db.execute(stmt)
            session = result.scalar_one_or_none()

            if session:
                return session.id

            # Pretty title from channel key
            title = sender_id
            if ":" in channel_user_key:
                title = channel_user_key.split(":", 1)[1]

            new_session = await create_session(db, title=title)
            new_session.slug = channel_user_key
            await db.commit()
            return new_session.id

    @staticmethod
    def _resolve_best_model(registry) -> str | None:
        """Pick the best model for channel responses."""
        all_models = registry.all_models()
        if not all_models:
            return None

        # Anthropic > paid > free
        anth = [m for m in all_models if m.provider_id == "anthropic"]
        if anth:
            return anth[0].id

        paid = [m for m in all_models if m.pricing and (m.pricing.prompt > 0 or m.pricing.completion > 0)]
        if paid:
            return paid[0].id

        return all_models[0].id
