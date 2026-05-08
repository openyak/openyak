"use client";

import { useMemo } from "react";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore } from "@/stores/settings-store";
import type { ActiveProvider } from "@/stores/settings-store";

/** Provider IDs that are NOT user-managed BYOK providers. */
const NON_BYOK_PROVIDERS = new Set(["openai-subscription", "openyak-proxy"]);

const PROVIDER_ID_MAP: Record<NonNullable<ActiveProvider>, string | null> = {
  openyak: "openyak-proxy",
  byok: null, // Special: show models from ALL BYOK providers
  chatgpt: "openai-subscription",
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

    if (providerId === null) {
      // "byok" mode: show models from all BYOK providers
      // (everything except subscription and openyak proxy)
      return allModels.filter((m) => !NON_BYOK_PROVIDERS.has(m.provider_id));
    }

    if (providerId.endsWith("_")) {
      // Prefix match (e.g. "custom_" → custom_abc, custom_xyz, …)
      return allModels.filter((m) => m.provider_id?.startsWith(providerId));
    }

    return allModels.filter((m) => m.provider_id === providerId);
  }, [allModels, activeProvider]);

  return { data, allModels, isLoading, isError, error, activeProvider };
}
