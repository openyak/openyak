"""Provider catalog — maps provider IDs to their configuration.

Defines which providers are available, how to create them (native SDK vs
OpenAI-compatible), and which Settings field holds their API key.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ProviderDef:
    """Desktop provider definition."""

    id: str
    name: str
    settings_key: str  # Field name in app.config.Settings (e.g. "openai_api_key")
    kind: str  # "openai_compat" | "native_anthropic" | "native_gemini"
    base_url: str = ""  # Only used by openai_compat providers
    default_headers: dict[str, str] = field(default_factory=dict)


# All providers that can be configured via direct API key (BYOK).
# OpenAI Subscription is NOT here — it has its own dedicated
# registration flow in main.py and api/config.py.
PROVIDER_CATALOG: dict[str, ProviderDef] = {
    "openrouter": ProviderDef(
        id="openrouter",
        name="OpenRouter",
        settings_key="openrouter_api_key",
        kind="openrouter",  # Special: uses existing OpenRouterProvider
    ),
    "openai": ProviderDef(
        id="openai",
        name="OpenAI",
        settings_key="openai_api_key",
        kind="openai_compat",
        base_url="https://api.openai.com/v1",
    ),
    "anthropic": ProviderDef(
        id="anthropic",
        name="Anthropic",
        settings_key="anthropic_api_key",
        kind="native_anthropic",
    ),
    "google": ProviderDef(
        id="google",
        name="Google Gemini",
        settings_key="google_api_key",
        kind="native_gemini",
    ),
    "groq": ProviderDef(
        id="groq",
        name="Groq",
        settings_key="groq_api_key",
        kind="openai_compat",
        base_url="https://api.groq.com/openai/v1",
    ),
    "deepseek": ProviderDef(
        id="deepseek",
        name="DeepSeek",
        settings_key="deepseek_api_key",
        kind="openai_compat",
        base_url="https://api.deepseek.com/v1",
    ),
    "mistral": ProviderDef(
        id="mistral",
        name="Mistral AI",
        settings_key="mistral_api_key",
        kind="openai_compat",
        base_url="https://api.mistral.ai/v1",
    ),
    "xai": ProviderDef(
        id="xai",
        name="xAI",
        settings_key="xai_api_key",
        kind="openai_compat",
        base_url="https://api.x.ai/v1",
    ),
    "together": ProviderDef(
        id="together",
        name="Together AI",
        settings_key="together_api_key",
        kind="openai_compat",
        base_url="https://api.together.xyz/v1",
    ),
    "deepinfra": ProviderDef(
        id="deepinfra",
        name="DeepInfra",
        settings_key="deepinfra_api_key",
        kind="openai_compat",
        base_url="https://api.deepinfra.com/v1/openai",
    ),
    "cerebras": ProviderDef(
        id="cerebras",
        name="Cerebras",
        settings_key="cerebras_api_key",
        kind="openai_compat",
        base_url="https://api.cerebras.ai/v1",
    ),
    "cohere": ProviderDef(
        id="cohere",
        name="Cohere",
        settings_key="cohere_api_key",
        kind="openai_compat",
        base_url="https://api.cohere.com/compatibility/v1",
    ),
    "perplexity": ProviderDef(
        id="perplexity",
        name="Perplexity",
        settings_key="perplexity_api_key",
        kind="openai_compat",
        base_url="https://api.perplexity.ai",
    ),
    "fireworks": ProviderDef(
        id="fireworks",
        name="Fireworks AI",
        settings_key="fireworks_api_key",
        kind="openai_compat",
        base_url="https://api.fireworks.ai/inference/v1",
    ),
    "azure": ProviderDef(
        id="azure",
        name="Azure OpenAI",
        settings_key="azure_openai_api_key",
        kind="openai_compat_azure",
        # base_url is user-provided via azure_openai_base_url setting
    ),
    # --- Chinese Providers ---
    "qwen": ProviderDef(
        id="qwen",
        name="Qwen (通义千问)",
        settings_key="qwen_api_key",
        kind="openai_compat",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    "kimi": ProviderDef(
        id="kimi",
        name="Kimi (月之暗面)",
        settings_key="kimi_api_key",
        kind="openai_compat",
        base_url="https://api.moonshot.cn/v1",
    ),
    "minimax": ProviderDef(
        id="minimax",
        name="MiniMax",
        settings_key="minimax_api_key",
        kind="openai_compat",
        base_url="https://api.minimaxi.com/v1",
    ),
    "zhipu": ProviderDef(
        id="zhipu",
        name="ZhipuAI (智谱)",
        settings_key="zhipu_api_key",
        kind="openai_compat",
        base_url="https://open.bigmodel.cn/api/paas/v4",
    ),
    "siliconflow": ProviderDef(
        id="siliconflow",
        name="SiliconFlow (硅基流动)",
        settings_key="siliconflow_api_key",
        kind="openai_compat",
        base_url="https://api.siliconflow.cn/v1",
    ),
    "xiaomi": ProviderDef(
        id="xiaomi",
        name="Xiaomi MiMo",
        settings_key="xiaomi_api_key",
        kind="openai_compat",
        base_url="https://api.xiaomimimo.com/v1",
    ),
}
