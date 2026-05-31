"""Tests for the curated vision-capability allowlist."""

from __future__ import annotations

import pytest

from app.provider.vision_allowlist import model_supports_vision


# Models that SHOULD be recognised as vision-capable. Covers the families most
# likely to reach a user with vision=False from upstream metadata, plus the
# vendor-prefixed (OpenRouter-style) and human-label forms.
VISION_MODELS = [
    # OpenAI — the reported case + the rest of the family
    "gpt-5.5",
    "gpt-5",
    "gpt-5-mini",
    "openai/gpt-5.5",
    "gpt-4o",
    "gpt-4o-mini",
    "chatgpt-4o-latest",
    "gpt-4.1",
    "gpt-4.1-nano",
    "gpt-4.5-preview",
    "gpt-4-turbo",
    "gpt-4-vision-preview",
    "o1",
    "o3",
    "o4-mini",
    # Anthropic
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20241022",
    "claude-3.7-sonnet",
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "anthropic/claude-3.5-sonnet",
    # Google
    "gemini-1.5-pro",
    "gemini-2.0-flash",
    "gemini-2.5-pro",
    "gemini-3-pro",
    "models/gemini-1.5-flash",
    "gemma-3-27b-it",
    "paligemma-3b",
    # Meta
    "llama-3.2-11b-vision-instruct",
    "llama-3.2-90b-vision",
    "llama-4-scout",
    "meta-llama/llama-4-maverick",
    # Mistral
    "pixtral-12b",
    "pixtral-large-latest",
    "mistral-small-3.1-24b-instruct",
    "mistral-small-2503",
    # Qwen
    "qwen2.5-vl-7b-instruct",
    "qwen-vl-max",
    "qwen2.5-omni-7b",
    "qvq-72b-preview",
    # xAI
    "grok-2-vision-1212",
    "grok-4",
    # Others / open VLMs
    "glm-4v",
    "glm-4.1v-thinking",
    "llava:13b",
    "llava-llama3",
    "moondream",
    "minicpm-v",
    "internvl2-8b",
    "phi-3.5-vision-instruct",
    "phi-4-multimodal-instruct",
    "smolvlm-instruct",
    # ---- 2026 families (verified against the live models.dev catalog +
    # provider release notes; many are mislabeled text-only by resellers) ----
    "qwen3.6-27b",
    "qwen3.7-max",
    "qwen3.5-397b-a17b",
    "qwen3-omni-realtime",
    "moonshotai/kimi-k2.6",
    "kimi-k2.5-thinking",
    "Kimi-K2_6",
    "kimi-latest",
    "google/gemma-4-31b-it",
    "gemma3:27b",
    "gemma-3n-e4b-it",
    "glm-5v-turbo",
    "mistral-medium-2604",
    "mistral-medium-3.5",
    "mistral-large-2512",
    "mistralai/ministral-14b-2512",
    "mistral-small-2603",
    "xiaomimimo/mimo-v2.5-pro",
    "doubao-seed-2-0-lite-260215",
    "doubao-seed-1.6-vision-250815",
    "amazon/nova-pro-v1",
    "nova-2-omni",
    "ernie-5.0",
    "ernie-4.5-vl-28b-a3b",
    "deepseek-vl2",
    "deepseek-ocr",
    "stepfun-ai/step-3.7-flash",
    "nvidia/nemotron-3-nano-omni",
    "sonar",
    "sonar-pro",
    "perceptron/perceptron-mk1",
    "rekaai/reka-flash-3",
    "meta-llama/llama-guard-4-12b",
    "minimaxai/minimax-vl-01",
    "ui-tars-1.5",
    "grok-3",
    "grok-build-0.1",
    "ministral-3-8b-instruct",     # named Ministral 3 (distinct from 2024 3b)
    "claude-sonnet-latest",
    # Capitalised display label only
    ("some-internal-id", "Internal Vision Model"),
]

# Models that must NOT be promoted — text-only, audio/speech, or generation.
# A wrong True here would send an image to a model that errors upstream.
NON_VISION_MODELS = [
    "gpt-3.5-turbo",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-32k",
    "o1-mini",
    "o3-mini",
    "gpt-4o-audio-preview",
    "gpt-4o-realtime-preview",
    "gpt-4o-transcribe",
    "gpt-4o-mini-tts",
    "text-embedding-3-large",
    "dall-e-3",
    "whisper-1",
    "omni-moderation-latest",
    "claude-2.1",
    "claude-instant-1.2",
    "gemini-1.0-pro",
    "gemma-3-1b-it",
    "imagen-3.0-generate-001",
    "llama-3.1-70b-instruct",
    "llama-3.2-3b-instruct",
    "mistral-large-latest",
    "codestral-latest",
    "qwen2.5-coder-32b-instruct",
    "deepseek-chat",
    "deepseek-r1",
    "text-moderation-stable",
    # ---- 2026 text-only flagships with a separate vision sibling (the guards
    # that keep precision: each has a multimodal cousin we DO match) ----
    "glm-5",                       # base text-only; glm-5v sees
    "glm-5-air",
    "ernie-5.1",                   # text-only; ernie-5.0 is full-modality
    "kimi-k2-0711",                # base K2 text-only; K2.5/K2.6 see
    "moonshotai/kimi-k2-instruct",
    "step-3.5-flash",              # text-only; step-3.7 sees
    "ministral-8b-2410",           # 2024 Ministral text-only; Ministral 3 sees
    "ministral-3b",                # 2024 Ministral 3B text-only (prefix trap)
    "ministral-3b-2410",
    "mistral-large-2411",          # Large 2 text-only; Large 3 sees
    "deepseek-v3.2",               # text; deepseek-vl2 / -ocr see
    "qwen3-32b",                   # Qwen3 (3.0) base text-only; 3.5+ see
    "nova-micro-v1",               # Nova Micro text-only
    "grok-3-mini",                 # grok mini reasoning is text-only
    "grok-3-mini-beta",
    "x-ai/grok-3-mini-fast",
    "gpt-4o-search-preview",       # text + web, no image input
    "gpt-4o-mini-search-preview",
    "gpt-4o-realtime-preview",     # audio/text realtime, no image input
]


@pytest.mark.parametrize("entry", VISION_MODELS)
def test_vision_models_recognised(entry):
    if isinstance(entry, tuple):
        model_id, name = entry
    else:
        model_id, name = entry, None
    assert model_supports_vision(model_id, name) is True, model_id


@pytest.mark.parametrize("model_id", NON_VISION_MODELS)
def test_non_vision_models_rejected(model_id):
    assert model_supports_vision(model_id) is False, model_id


def test_empty_id_is_false():
    assert model_supports_vision("") is False
    assert model_supports_vision("", "Whatever") is False


def test_case_insensitive():
    assert model_supports_vision("GPT-4O") is True
    assert model_supports_vision("Claude-3-Opus") is True


def test_deny_overrides_allow():
    # "o3" allows, but the "-mini" sibling is denied and must win.
    assert model_supports_vision("o3") is True
    assert model_supports_vision("o3-mini") is False
