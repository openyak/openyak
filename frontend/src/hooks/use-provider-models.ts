"use client";

import { useMemo } from "react";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore } from "@/stores/settings-store";
import { isByokProviderId, isCustomEndpointProviderId } from "@/lib/providers";

export function useProviderModels() {
  const { data: allModels, isLoading, isError, error } = useModels();
  const activeProvider = useSettingsStore((s) => s.activeProvider);

  const data = useMemo(() => {
    if (!allModels) return [];
    if (!activeProvider) return [];

    if (activeProvider === "byok") {
      // "byok" mode: show models from all BYOK providers
      // (everything except subscription, Ollama, and custom/local endpoints)
      return allModels.filter((m) => isByokProviderId(m.provider_id));
    }

    if (activeProvider === "custom") {
      return allModels.filter((m) => isCustomEndpointProviderId(m.provider_id));
    }

    if (activeProvider === "chatgpt") {
      return allModels.filter((m) => m.provider_id === "openai-subscription");
    }

    if (activeProvider === "ollama") {
      return allModels.filter((m) => m.provider_id === "ollama");
    }

    if (activeProvider === "rapid-mlx") {
      return allModels.filter((m) => m.provider_id === "rapid-mlx");
    }

    return [];
  }, [allModels, activeProvider]);

  return { data, allModels, isLoading, isError, error, activeProvider };
}
