"""Rapid-MLX model aliases shared by runtime and provider code."""

from __future__ import annotations

RAPID_MLX_ALIAS_REPOS: dict[str, str] = {
    "deepseek-r1-32b": "mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit",
    "deepseek-r1-8b": "mlx-community/DeepSeek-R1-0528-Qwen3-8B-4bit",
    "devstral-v2-24b": "mlx-community/Devstral-Small-2-24B-Instruct-2512-4bit",
    "gemma-4-26b": "mlx-community/gemma-4-26b-a4b-it-4bit",
    "gemma-4-31b": "mlx-community/gemma-4-31b-it-4bit",
    "gpt-oss-20b": "mlx-community/GPT-OSS-20B-4bit",
    "mistral-24b": "mlx-community/Mistral-Small-3.1-24B-Instruct-2503-4bit",
    "nemotron-30b": "lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-MLX-4bit",
    "qwen3-coder": "lmstudio-community/Qwen3-Coder-Next-MLX-4bit",
    "qwen3-coder-30b": "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
    "qwen3-vl-30b": "mlx-community/Qwen3-VL-30B-A3B-Instruct-4bit",
    "qwen3-vl-4b": "mlx-community/Qwen3-VL-4B-Instruct-MLX-4bit",
    "qwen3-vl-8b": "mlx-community/Qwen3-VL-8B-Instruct-4bit",
    "qwen3.5-122b": "nightmedia/Qwen3.5-122B-A10B-Text-mxfp4-mlx",
    "qwen3.5-122b-8bit": "mlx-community/Qwen3.5-122B-A10B-8bit",
    "qwen3.5-27b": "mlx-community/Qwen3.5-27B-4bit",
    "qwen3.5-35b": "mlx-community/Qwen3.5-35B-A3B-8bit",
    "qwen3.5-4b": "mlx-community/Qwen3.5-4B-MLX-4bit",
    "qwen3.5-9b": "mlx-community/Qwen3.5-9B-4bit",
    "qwen3.6-27b": "mlx-community/Qwen3.6-27B-4bit",
    "qwen3.6-27b-8bit": "unsloth/Qwen3.6-27B-MLX-8bit",
    "qwen3.6-35b": "mlx-community/Qwen3.6-35B-A3B-4bit",
    "qwen3.6-35b-6bit": "mlx-community/Qwen3.6-35B-A3B-6bit",
}

_VISION_ALIASES = {
    "gemma-4-26b",
    "gemma-4-31b",
    "qwen3-vl-4b",
    "qwen3-vl-8b",
    "qwen3-vl-30b",
}

_REPO_TO_ALIAS = {
    repo.strip().lower(): alias for alias, repo in RAPID_MLX_ALIAS_REPOS.items()
}


def bare_rapid_mlx_model(value: str) -> str:
    """Strip provider prefix and whitespace from a Rapid-MLX model id."""
    return value.strip().removeprefix("rapid-mlx/").strip()


def resolve_rapid_mlx_repo(alias_or_repo: str) -> str:
    """Resolve a known short alias to its HuggingFace repo id."""
    model = bare_rapid_mlx_model(alias_or_repo)
    return RAPID_MLX_ALIAS_REPOS.get(model, model)


def canonical_rapid_mlx_model(value: str) -> str:
    """Return a stable lowercase identity for alias/repo comparisons."""
    model = bare_rapid_mlx_model(value)
    if not model:
        return ""
    return resolve_rapid_mlx_repo(model).lower()


def rapid_mlx_model_supports_vision(value: str) -> bool:
    """Return whether a Rapid-MLX alias/repo is known to support image input."""
    model = bare_rapid_mlx_model(value)
    if not model:
        return False
    lower_model = model.lower()
    alias = lower_model if lower_model in RAPID_MLX_ALIAS_REPOS else _REPO_TO_ALIAS.get(lower_model)
    if alias in _VISION_ALIASES:
        return True
    return "qwen3-vl" in lower_model or "gemma-4" in lower_model
