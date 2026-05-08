"use client";

import { useMemo } from "react";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore } from "@/stores/settings-store";
import type { ActiveProvider } from "@/stores/settings-store";

const PROVIDER_ID_MAP: Record<NonNullable<ActiveProvider>, string> = {
  openyak: "openyak-proxy",
  chatgpt: "openai-subscription",
  ollama: "ollama",
  local: "local",
  custom: "custom_", // Prefix match: show models from custom_* providers only
};

export function useProviderModels() {
  const { data: allModels, isLoading, isError, error } = useModels();
  const activeProvider = useSettingsStore((s) => s.activeProvider);

  const data = useMemo(() => {
    if (!allModels) return [];
    if (!activeProvider) return [];

    const providerId = PROVIDER_ID_MAP[activeProvider];

    if (providerId.endsWith("_")) {
      // Prefix match (e.g. "custom_" → custom_abc, custom_xyz, …)
      return allModels.filter((m) => m.provider_id?.startsWith(providerId));
    }

    return allModels.filter((m) => m.provider_id === providerId);
  }, [allModels, activeProvider]);

  return { data, allModels, isLoading, isError, error, activeProvider };
}
