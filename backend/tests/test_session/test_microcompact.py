from app.session.microcompact import microcompact_messages


def test_old_computer_screenshot_is_replaced_but_recent_one_is_kept():
    old_image = "data:image/jpeg;base64," + "A" * 10_000
    recent_image = "data:image/jpeg;base64," + "B" * 10_000
    messages = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "old",
                "type": "function",
                "function": {"name": "computer", "arguments": "{}"},
            }],
        },
        {
            "role": "tool",
            "tool_call_id": "old",
            "content": [
                {"type": "text", "text": "old screenshot"},
                {"type": "image_url", "image_url": {"url": old_image}},
            ],
        },
        {"role": "assistant", "content": "intermediate"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "recent",
                "type": "function",
                "function": {"name": "computer", "arguments": "{}"},
            }],
        },
        {
            "role": "tool",
            "tool_call_id": "recent",
            "content": [
                {"type": "text", "text": "recent screenshot"},
                {"type": "image_url", "image_url": {"url": recent_image}},
            ],
        },
    ]

    compacted = microcompact_messages(messages, skip_recent_turns=1)

    assert compacted[1]["content"].startswith("[Previous computer output cleared")
    assert compacted[4]["content"][1]["image_url"]["url"] == recent_image
