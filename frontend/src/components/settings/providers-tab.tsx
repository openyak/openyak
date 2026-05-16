"use client";

import { useEffect, useState } from "react";
import {
  CreditCard,
  Cpu,
  Eye,
  Plug,
  Zap,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settings-store";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import { useModels } from "@/hooks/use-models";
import type {
  ApiKeyStatus,
  LocalProviderStatus,
  ProviderInfo,
} from "@/types/usage";
import type { ModelInfo } from "@/types/model";
import { OllamaPanel } from "@/components/settings/ollama-panel";
import { RapidMLXPanel } from "@/components/settings/rapid-mlx-panel";
import { ByokPanel } from "@/components/settings/providers/byok-panel";
import { ChatGPTSubPanel } from "@/components/settings/providers/chatgpt-sub-panel";
import { CustomEndpointPanel } from "@/components/settings/providers/custom-endpoint-panel";

type ProviderMode = "byok" | "chatgpt" | "ollama" | "rapid-mlx" | "custom";

interface OpenAISubscriptionStatus {
  is_connected: boolean;
}
interface OllamaRuntimeStatus {
  binary_installed: boolean;
  running: boolean;
}
interface RapidMLXRuntimeStatus {
  running: boolean;
}

function pickModelForMode(
  mode: ProviderMode,
  models: ModelInfo[] | undefined,
): ModelInfo | null {
  if (!models || models.length === 0) return null;
  if (mode === "byok") {
    return (
      models.find(
        (m) =>
          !["openai-subscription", "ollama", "rapid-mlx", "local"].includes(
            m.provider_id,
          ) && !m.provider_id?.startsWith("custom_"),
      ) ?? null
    );
  }
  if (mode === "chatgpt") {
    return (
      models.find((m) => m.provider_id === "openai-subscription") ?? null
    );
  }
  if (mode === "ollama") {
    return models.find((m) => m.provider_id === "ollama") ?? null;
  }
  if (mode === "rapid-mlx") {
    return models.find((m) => m.provider_id === "rapid-mlx") ?? null;
  }
  if (mode === "custom") {
    return (
      models.find(
        (m) =>
          m.provider_id === "local" || m.provider_id?.startsWith("custom_"),
      ) ?? null
    );
  }
  return null;
}

export function ProvidersTab() {
  const { t } = useTranslation("settings");
  const { activeProvider, setActiveProvider } = useSettingsStore();

  const [viewingProvider, setViewingProvider] = useState<ProviderMode>(
    () => (activeProvider as ProviderMode) ?? "byok",
  );
  const [mounted, setMounted] = useState(false);

  const { data: allModels } = useModels();

  const { data: keyStatus } = useQuery({
    queryKey: queryKeys.apiKeyStatus,
    queryFn: () => api.get<ApiKeyStatus>(API.CONFIG.API_KEY),
  });
  const { data: providers } = useQuery({
    queryKey: queryKeys.providers,
    queryFn: () => api.get<ProviderInfo[]>(API.CONFIG.PROVIDERS),
  });
  const { data: localStatus } = useQuery({
    queryKey: queryKeys.localProvider,
    queryFn: () => api.get<LocalProviderStatus>(API.CONFIG.LOCAL_PROVIDER),
  });
  const { data: openaiSubStatus } = useQuery({
    queryKey: queryKeys.openaiSubscription,
    queryFn: () =>
      api.get<OpenAISubscriptionStatus>(API.CONFIG.OPENAI_SUBSCRIPTION),
  });
  const { data: ollamaRuntimeStatus } = useQuery({
    queryKey: ["ollamaRuntime"],
    queryFn: () => api.get<OllamaRuntimeStatus>(API.OLLAMA.STATUS),
  });
  const { data: rapidMlxRuntimeStatus } = useQuery({
    queryKey: ["rapidMlxRuntime"],
    queryFn: () => api.get<RapidMLXRuntimeStatus>(API.RAPID_MLX.STATUS),
    retry: false,
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  const activateProviderMode = (mode: ProviderMode) => {
    setActiveProvider(mode);
    const picked = pickModelForMode(mode, allModels);
    if (picked) {
      useSettingsStore
        .getState()
        .setSelectedModel(picked.id, picked.provider_id);
    }
  };

  const fallbackToOtherProviders = () => {
    if (openaiSubStatus?.is_connected) {
      setActiveProvider("chatgpt");
    } else if (rapidMlxRuntimeStatus?.running) {
      setActiveProvider("rapid-mlx");
    } else if (
      localStatus?.is_connected ||
      (providers ?? []).some(
        (p) => p.id.startsWith("custom_") && p.is_configured,
      )
    ) {
      setActiveProvider("custom");
    } else if (
      keyStatus?.is_configured ||
      (providers ?? []).some((p) => p.is_configured)
    ) {
      setActiveProvider("byok");
    } else {
      setActiveProvider(null);
    }
  };

  const ollamaConnected = !!ollamaRuntimeStatus?.running;
  const rapidMlxConnected = !!rapidMlxRuntimeStatus?.running;
  const customConnected =
    !!localStatus?.is_connected ||
    (providers ?? []).some(
      (p) => p.id.startsWith("custom_") && p.is_configured,
    );

  const modes: Array<{
    mode: ProviderMode;
    label: string;
    icon: typeof Eye;
    connected: boolean;
  }> = [
    {
      mode: "byok",
      label: t("ownApiKey"),
      icon: Eye,
      connected:
        !!keyStatus?.is_configured ||
        (providers ?? []).some(
          (p) => p.is_configured && !p.id.startsWith("custom_"),
        ),
    },
    {
      mode: "chatgpt",
      label: t("chatgptSubscription"),
      icon: CreditCard,
      connected: !!openaiSubStatus?.is_connected,
    },
    { mode: "ollama", label: "Ollama", icon: Cpu, connected: ollamaConnected },
    {
      mode: "rapid-mlx",
      label: "Rapid-MLX",
      icon: Zap,
      connected: rapidMlxConnected,
    },
    {
      mode: "custom",
      label: t("customEndpoint"),
      icon: Plug,
      connected: customConnected,
    },
  ];

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-secondary)]">
        {t("providerModeDesc")}
      </p>

      {/* Provider cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {modes.map(({ mode, label, icon: Icon, connected }) => (
          <button
            key={mode}
            onClick={() => {
              setViewingProvider(mode);
              if (connected) activateProviderMode(mode);
            }}
            className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors relative ${
              viewingProvider === mode
                ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
            }`}
          >
            <Icon className="h-5 w-5" />
            <span className="text-xs font-medium text-center leading-tight">
              {label}
            </span>
            {mounted && connected && (
              <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--color-success)]" />
            )}
            {activeProvider === mode && mounted && connected && (
              <span className="absolute bottom-1 text-ui-3xs font-medium text-[var(--brand-primary)]">
                {t("activeProvider")}
              </span>
            )}
          </button>
        ))}
      </div>

      {viewingProvider === "byok" && (
        <ByokPanel
          providers={providers}
          onSaved={() => activateProviderMode("byok")}
        />
      )}
      {viewingProvider === "chatgpt" && (
        <ChatGPTSubPanel keyStatus={keyStatus} />
      )}
      {viewingProvider === "ollama" && <OllamaPanel />}
      {viewingProvider === "rapid-mlx" && <RapidMLXPanel />}
      {viewingProvider === "custom" && (
        <CustomEndpointPanel
          providers={providers}
          localStatus={localStatus}
          onLocalDeleted={() => {
            if (activeProvider === "custom") fallbackToOtherProviders();
          }}
        />
      )}
    </div>
  );
}
