"""Session utility tests."""

from types import SimpleNamespace

from app.session.utils import (
    compute_usable_context_window,
    compute_effective_context_window,
    get_effective_context_window,
    has_image_attachments,
    llm_messages_have_image_content,
    sanitize_llm_messages_for_request,
)


def test_sanitize_preserves_multiple_large_user_turns_for_large_context_models():
    huge = "Please read this.\n\n" + ("alpha beta gamma delta " * 40_000)
    messages = [
        {"role": "user", "content": huge},
        {"role": "assistant", "content": "READY"},
        {"role": "user", "content": huge},
        {"role": "assistant", "content": "READY"},
        {"role": "user", "content": "What was your previous answer?"},
    ]

    sanitized = sanitize_llm_messages_for_request(
        messages,
        session_id="demo",
        model_max_context=1_050_000,
    )

    # Previously a hard 500k-char cap dropped the earlier large turns entirely,
    # leaving only the newest message(s). Large-context models should retain
    # both oversized user turns until we actually approach the real window.
    assert [m["role"] for m in sanitized] == [
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
    ]
    assert sanitized[0]["content"].startswith("Please read this.")
    assert sanitized[2]["content"].startswith("Please read this.")


def test_sanitize_partially_trims_oldest_message_instead_of_dropping_history():
    huge = "Please read this.\n\n" + ("alpha beta gamma delta " * 40_000)
    messages = []
    for _ in range(5):
        messages.append({"role": "user", "content": huge})
        messages.append({"role": "assistant", "content": "READY"})

    sanitized = sanitize_llm_messages_for_request(
        messages,
        session_id="demo",
        model_max_context=1_050_000,
    )

    # When we finally exceed the model-scaled budget, keep all recent turns and
    # trim the oldest oversized message rather than silently deleting it.
    assert len(sanitized) == len(messages)
    assert sanitized[0]["role"] == "user"
    assert "[user content truncated for context:" in sanitized[0]["content"]
    assert sanitized[-2]["role"] == "user"
    assert sanitized[-2]["content"].startswith("Please read this.")


def test_effective_context_window_prefers_metadata_override():
    model_info = SimpleNamespace(
        capabilities=SimpleNamespace(max_context=1_050_000),
        metadata={"effective_context_window": 258_000},
    )

    assert get_effective_context_window(model_info) == 258_000


def test_effective_context_window_is_clamped_to_max_context():
    model_info = SimpleNamespace(
        capabilities=SimpleNamespace(max_context=128_000),
        metadata={"effective_context_window": 258_000},
    )

    assert get_effective_context_window(model_info) == 128_000


def test_effective_context_window_defaults_to_full_context():
    assert compute_effective_context_window(200_000) == 200_000
    assert compute_effective_context_window(256_000) == 256_000


def test_usable_context_window_subtracts_output_and_reserved_budget():
    assert compute_usable_context_window(
        128_000,
        model_max_output=8_192,
        reserved=8_192,
    ) == 111_616


def test_image_attachment_detection_covers_mime_extension_and_mobile_type():
    assert has_image_attachments([{"name": "chart.png", "mime_type": ""}])
    assert has_image_attachments([{"name": "upload", "mime_type": "image/jpeg"}])
    assert has_image_attachments([{"type": "image", "path": "/tmp/no-ext"}])
    assert not has_image_attachments([{"name": "notes.txt", "mime_type": "text/plain"}])


def test_llm_messages_have_image_content_detects_multimodal_blocks():
    assert llm_messages_have_image_content([
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "describe"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
            ],
        }
    ])
    assert not llm_messages_have_image_content([{"role": "user", "content": "plain"}])
