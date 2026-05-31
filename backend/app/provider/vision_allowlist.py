"""Curated vision-capability allowlist.

Why this exists
---------------
A model's ``capabilities.vision`` flag drives two user-facing gates: the
composer warning ("this model can't read images") and the backend's hard
rejection of image attachments. Both read the *same* flag, and that flag is
sourced from upstream metadata (models.dev modalities, a provider's
``/v1/models`` listing, a hand-written catalog). That metadata is routinely
missing or wrong:

* BYOK / custom OpenAI-compatible endpoints discover models via ``/v1/models``,
  which never reports modalities → every model lands as ``vision=False``.
* models.dev only marks ``vision`` when it lists ``image`` in the model's input
  modalities, and individual reseller entries frequently omit it (we have seen
  ``claude-opus``, ``gpt-5-mini``, ``llama-3.2-90b-vision`` all mislabeled
  text-only by some provider rows).

The result is false "can't read images" warnings on models that obviously can.
Rather than trust upstream, we keep a curated allowlist of known vision-capable
model *families* and use it as an additive safety net.

How it's used
-------------
``model_supports_vision(model_id, name)`` is applied once, centrally, in
``ProviderRegistry`` when models are collected. It is **additive**: a provider
that already reports ``vision=True`` is never downgraded — the allowlist only
*promotes* a missed ``False`` to ``True``. A false negative here just preserves
today's behaviour; a false positive would let an image reach a text-only model
and error upstream, so the patterns favour precision and a small DENY list
guards the text-only / non-image siblings of otherwise-vision families
(``o1-mini``, ``gpt-4o-audio``, ``gemma-3-1b``, ``nova-micro``, …).

Currency
--------
Curated 2026-05 and cross-checked against the live models.dev catalog plus
provider release notes. Several 2026 families have a *text-only flagship with a
separate vision variant* — the patterns below encode those splits deliberately:
``glm-5`` is text-only (only ``glm-5v`` sees), ``ernie-5.1`` is text-only
(``ernie-5.0`` is full-modality), bare ``kimi-k2`` is text-only (``k2.5``/``k2.6``
see), ``step-3.5`` is text-only (``step-3.7`` sees), ``ministral`` 2024 is
text-only (``ministral-3`` sees), ``nova-micro`` is text-only.

Maintaining it
--------------
To teach OpenYak about a new vision model, add a pattern to ``_ALLOW`` (grouped
by vendor). Patterns are ``re.search``-ed against a lowercased ``"id\\nname"``
haystack, so they match whether or not the id carries a ``vendor/`` prefix
(``gpt-4o`` and OpenRouter's ``openai/gpt-4o`` both hit). Add a pattern to
``_DENY`` when a text-only or audio-only sibling would otherwise be caught by a
broad family pattern.
"""

from __future__ import annotations

import re

# --------------------------------------------------------------------------- #
# DENY — evaluated first. A hit here forces vision=False, overriding any ALLOW
# match. These are the non-image siblings of families that ALLOW would catch:
# text-only reasoning minis, audio/speech/embedding variants, image *generation*
# (output, not input), and the lone text-only size/tier of a multimodal family.
# --------------------------------------------------------------------------- #
_DENY: list[str] = [
    r"o1-mini",            # o1 is vision; o1-mini is text-only
    r"o3-mini",            # o3 is vision; o3-mini is text-only
    r"grok-[3-9]-mini",    # grok mini reasoning models are text-only (cf. o*-mini)
    r"gemma-?3-1b",        # the one text-only size in the multimodal gemma-3 line
    r"nova[\w-]*micro",    # Amazon Nova Micro (incl. nova-2-micro) is text-only
    r"audio",              # gpt-4o-audio-* etc. — speech in/out, not image
    r"4o-(?:mini-)?realtime",  # gpt-4o(-mini)-realtime — audio/text, not image input
    r"search-preview",     # gpt-4o(-mini)-search-preview — text + web, no image input
    r"transcribe",         # gpt-4o-transcribe — speech-to-text
    r"\btts\b",            # text-to-speech
    r"whisper",            # speech-to-text
    r"embed",              # embedding models (incl. multimodal embeddings)
    r"moderation",         # moderation endpoints (incl. omni-moderation)
    r"dall-?e",            # image *generation*, not vision input
    r"\bimagen\b",         # Google image generation
    r"image-generation",
    r"stable-diffusion",
]

# --------------------------------------------------------------------------- #
# ALLOW — known vision-capable model families, grouped by vendor. Kept as a
# readable list and compiled into one alternation. Precision over recall: a
# missed model is the status quo, a wrong match sends images to a text model.
# --------------------------------------------------------------------------- #
_ALLOW: list[str] = [
    # ---- OpenAI / Azure OpenAI ----
    r"gpt-4o",              # gpt-4o, gpt-4o-mini, chatgpt-4o-latest
    r"chatgpt-4o",
    r"gpt-4\.1",            # gpt-4.1 / -mini / -nano
    r"gpt-4\.5",
    r"gpt-4-turbo",
    r"gpt-4[\w.-]*vision",  # gpt-4-vision-preview, gpt-4-1106-vision-preview
    r"gpt-?5",              # gpt-5, gpt-5.x, -mini/-nano/-codex — all multimodal
    r"gpt-latest",          # OpenRouter "gpt-latest" / "gpt-mini-latest" aliases
    r"gpt-chat-latest",
    r"\bo1\b",              # o1 (o1-mini denied)
    r"\bo3\b",              # o3 (o3-mini denied)
    r"\bo4\b",              # o4-mini is vision

    # ---- Anthropic ----
    r"claude-3",                       # claude-3 / 3.5 / 3.7
    r"claude-(?:opus|sonnet|haiku)",   # every modern tier (incl. -4-x and -latest)
    r"claude-[4-9]",                   # legacy claude-4* style ids

    # ---- Google Gemini / Gemma ----
    r"gemini-1\.5",
    r"gemini-2",            # gemini-2.0 / 2.5
    r"gemini-3",
    r"gemini-exp",
    r"gemini-flash",        # flash started at 1.5 — all multimodal
    r"gemini-pro-latest",
    r"gemini-pro-vision",
    r"gemma-?3",            # gemma-3 / gemma3 / gemma-3n (gemma-3-1b denied)
    r"gemma-?4",            # all sizes (E2B/E4B/26B/31B) are multimodal
    r"paligemma",

    # ---- Meta Llama ----
    r"llama-?3\.2-(?:11b|90b)",   # only the vision sizes of llama-3.2
    r"llama[\w.-]*vision",        # any explicit *-vision llama
    r"llama-?4",                  # llama 4 is natively multimodal
    r"llama-guard-4",             # Llama Guard 4 is natively multimodal

    # ---- Mistral (Mistral 3 generation is multimodal; 2024 versions were not,
    # so date-named ids are gated on 2025+ stamps to exclude Large 2 / 8B-2410) ----
    r"pixtral",
    r"mistral-small-3",           # Small 3.1 / 3.2 by name
    r"mistral-small-4",           # Small 4
    r"mistral-small-250[3-9]",    # Small 3.1 (2503) / 3.2 (2506)
    r"mistral-small-2[6-9]",      # 2026+ dated small (all multimodal)
    r"mistral-small-latest",
    r"mistral-medium-3",          # medium 3.x is multimodal
    r"mistral-medium-latest",
    r"mistral-medium-2[5-9]",     # date-named medium 3.x (2505, 2604, …)
    r"mistral-large-3",           # Large 3 sees (Large 2 did not)
    r"mistral-large-2[5-9]",      # Large 3 by date (2512+); excludes Large 2 (24xx)
    r"ministral-3\b",             # Ministral 3 (named); \b excludes 2024 ministral-3b
    r"ministral-\d+b-2[5-9]",     # Ministral 3 by date (…-2512); excludes 8B-2410

    # ---- Alibaba Qwen ----
    r"qwen[\w.-]*-vl",      # qwen-vl, qwen2-vl, qwen2.5-vl, qwen3-vl
    r"qwen[\w.-]*-omni",    # qwen2.5-omni / qwen3-omni
    r"qwen-?3\.[567]",      # qwen3.5 / 3.6 / 3.7 flagships are natively multimodal
    r"qwen-?3-[567]\b",     # dash/date-stamped variants (qwen3-6, qwen3-5-02-15)
    r"qvq",                 # qvq visual reasoning
    r"\bovis",              # Alibaba Ovis VLM (anchored: not "provisional" etc.)

    # ---- Moonshot Kimi ----
    r"kimi-k2[._p-]?[56]",  # K2.5 / K2.6 (incl. k2_6, k2p6); base K2 is text-only
    r"kimi-latest",         # alias now points to a multimodal K2.x
    r"kimi-vl",

    # ---- Zhipu / Z.ai GLM ----
    r"glm-4v",
    r"glm-4\.[1-9]v",       # glm-4.1v, glm-4.5v, …
    r"glm-5v",              # GLM-5 base is text-only; only GLM-5V sees

    # ---- xAI Grok ----
    r"grok-[3-9]",          # grok 3/4/… are multimodal (grok-2 base is text)
    r"grok-2-vision",
    r"grok-build",          # Grok Build 0.1 takes image input
    r"grok[\w.-]*vision",

    # ---- Xiaomi MiMo ----
    r"mimo-v2\.5",
    r"mimo-v2-5",
    r"mimo-v2-omni",
    r"mimo-vl",

    # ---- ByteDance Doubao / Seed ----
    r"doubao[\w.-]*vision",
    r"doubao-seed-1\.[68]",      # Seed 1.6 / 1.8 are multimodal
    r"doubao-seed-2",            # Seed 2.0
    r"\bseed-1\.[68]\b",
    r"\bseed-2\.0\b",
    r"\bseed-[12]-\d",           # seed-1-6, seed-2-0 (date/dash form)
    r"ui-tars",                  # ByteDance UI-TARS GUI agent (vision)

    # ---- Amazon Nova ----
    r"nova-(?:lite|pro|premier)",   # multimodal tiers (nova-micro denied)
    r"nova-2",                      # Nova 2 Lite/Pro/Omni

    # ---- Baidu ERNIE ----
    r"ernie-5\.0",          # 5.0 is full-modality; 5.1 is text-only
    r"ernie[\w.-]*-vl",     # ERNIE-VL family

    # ---- DeepSeek ----
    r"deepseek-vl",
    r"deepseek-ocr",
    r"\bjanus\b",           # DeepSeek Janus multimodal

    # ---- StepFun ----
    r"step-3\.7",           # 3.7 sees; 3.5 is text-only
    r"step-3-7",
    r"step-1v",
    r"step-1o",

    # ---- NVIDIA Nemotron ----
    r"nemotron[\w.-]*omni",      # Nemotron 3 (Nano) Omni; plain nemotron is text

    # ---- Perplexity ----
    r"\bsonar\b",                # Sonar supports image upload

    # ---- Other multimodal labs ----
    r"minimax-vl",
    r"minimax[\w.-]*vl",
    r"perceptron",               # Perceptron Mk1 VLM
    r"reka-(?:edge|flash|core|spark)",

    # ---- Open multimodal models (also seen via Ollama / OpenRouter) ----
    r"llava",
    r"bakllava",
    r"moondream",
    r"minicpm-v",
    r"minicpm-o",
    r"internvl",
    r"cogvlm",
    r"phi-3[\w.-]*vision",     # phi-3-vision, phi-3.5-vision
    r"phi-4[\w.-]*multimodal", # phi-4-multimodal
    r"idefics",
    r"smolvlm",
    r"aya-vision",

    # ---- Generic naming signals — broad but reliable for VLMs ----
    r"\bvision",           # any *-vision id (anchored: not supervision/revision)
    r"multimodal",
    r"-vl\b",
    r"-vl-",
    r"\bomni\b",
]


_DENY_RE = re.compile("|".join(_DENY), re.IGNORECASE)
_ALLOW_RE = re.compile("|".join(_ALLOW), re.IGNORECASE)


def model_supports_vision(model_id: str, name: str | None = None) -> bool:
    """Return True if the model id/name is a known vision-capable model.

    Matches case-insensitively against both the id and the display name, so a
    ``vendor/`` prefix (OpenRouter-style) or a human label still resolves. DENY
    patterns win over ALLOW. This is an *additive* hint — callers should OR it
    with any capability the provider already reported and never downgrade.
    """
    if not model_id:
        return False
    haystack = f"{model_id}\n{name or ''}".lower()
    if _DENY_RE.search(haystack):
        return False
    return bool(_ALLOW_RE.search(haystack))
