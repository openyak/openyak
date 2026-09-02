"""Channel AgentAdapter metadata contract tests."""

from app.channels.adapter import AgentAdapter
from app.channels.bus.events import InboundMessage


def test_stream_metadata_preserves_trigger_message_and_thread():
    inbound = InboundMessage(
        channel="telegram",
        sender_id="42",
        chat_id="100",
        content="hello",
        metadata={
            "message_id": 7,
            "message_thread_id": 55,
            "telegram": {"large_vendor_event": True},
            "_wants_stream": True,
        },
    )

    delta = AgentAdapter._stream_metadata(inbound)
    end = AgentAdapter._stream_metadata(inbound, stream_end=True, streamed=True)

    assert delta == {
        "_stream_delta": True,
        "message_id": 7,
        "message_thread_id": 55,
    }
    assert end == {
        "_stream_delta": True,
        "message_id": 7,
        "message_thread_id": 55,
        "_stream_end": True,
        "_streamed": True,
    }


def test_stream_metadata_omits_missing_optional_reply_context():
    inbound = InboundMessage(
        channel="telegram",
        sender_id="42",
        chat_id="100",
        content="hello",
    )
    assert AgentAdapter._stream_metadata(inbound) == {"_stream_delta": True}

