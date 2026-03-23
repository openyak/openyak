"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSettingsStore } from "@/stores/settings-store";
import { useAuthStore } from "@/stores/auth-store";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { ApiKeyStatus } from "@/types/usage";

interface OpenAISubscriptionStatus {
  is_connected: boolean;
  email: string;
  needs_reauth?: boolean;
}

interface OllamaRuntimeStatus {
  binary_installed: boolean;
  running: boolean;
}

/**
 * Auto-detect and set activeProvider when it is null.
 * Should be called at the layout level so it runs regardless of which page the user visits.
 */
export function useAutoDetectProvider(): { hasProvider: boolean } {
  const activeProvider = useSettingsStore((s) => s.activeProvider);
  const setActiveProvider = useSettingsStore((s) => s.setActiveProvider);
  const isConnected = useAuthStore((s) => s.isConnected);

  const { data: keyStatus } = useQuery({
    queryKey: queryKeys.apiKeyStatus,
    queryFn: () => api.get<ApiKeyStatus>(API.CONFIG.API_KEY),
  });

  const { data: openaiSubStatus } = useQuery({
    queryKey: queryKeys.openaiSubscription,
    queryFn: () => api.get<OpenAISubscriptionStatus>(API.CONFIG.OPENAI_SUBSCRIPTION),
  });

  const { data: ollamaRuntimeStatus } = useQuery({
    queryKey: ["ollamaRuntime"],
    queryFn: () => api.get<OllamaRuntimeStatus>(API.OLLAMA.STATUS),
    refetchInterval: activeProvider === null ? 10_000 : false,
  });

  const ollamaConnected = !!ollamaRuntimeStatus?.running;

  useEffect(() => {
    if (activeProvider !== null) return;
    if (openaiSubStatus?.is_connected) setActiveProvider("chatgpt");
    else if (isConnected) setActiveProvider("openyak");
    else if (keyStatus?.is_configured) setActiveProvider("byok");
    else if (ollamaConnected) setActiveProvider("ollama");
  }, [activeProvider, openaiSubStatus?.is_connected, isConnected, keyStatus?.is_configured, ollamaConnected, setActiveProvider]);

  return { hasProvider: activeProvider !== null };
}
