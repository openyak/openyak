"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore, type ActiveProvider } from "@/stores/settings-store";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { SessionResponse } from "@/types/session";

/**
 * Map a model's `provider_id` to the `activeProvider` UI bucket that surfaces
 * it in the model dropdown. Mirrors the filtering in {@link useProviderModels}.
 */
function providerBucketFor(providerId: string): Exclude<ActiveProvider, null> {
  if (providerId === "openai-subscription") return "chatgpt";
  if (providerId === "ollama") return "ollama";
  if (providerId === "rapid-mlx") return "rapid-mlx";
  if (providerId === "local" || providerId.startsWith("custom_")) return "custom";
  return "byok";
}

/**
 * Per-session model memory: restore the model a session was last using when
 * the user enters it.
 *
 * The backend persists `model_id` / `provider_id` on the session row (set on
 * every prompt). On session entry we set the global selector to that model —
 * but with three guards so we never surprise the user:
 *
 *   1. **Once per entry.** We restore exactly once per `sessionId`, so a manual
 *      model switch the user makes *after* entering the session is never undone.
 *   2. **Only if the model still exists.** If the stored model was removed
 *      (provider disconnected, model deprecated), we leave the current
 *      selection alone rather than stranding the selector on a dead model.
 *   3. **Switch the provider bucket too.** Setting `activeProvider` to match
 *      keeps the dropdown's auto-select from immediately overriding the restore.
 *
 * Sessions with no stored model (brand-new or pre-feature) fall through to the
 * existing global default — no behavior change.
 */
export function useSessionModelRestore(sessionId: string): void {
  const { data: allModels } = useModels();
  const { data: session } = useQuery({
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: () => api.get<SessionResponse>(API.SESSIONS.DETAIL(sessionId)),
    staleTime: 30_000,
  });

  // Tracks the session we've already restored for, so the effect is a one-shot
  // per entry even as the session/model queries settle across renders.
  const restoredFor = useRef<string | null>(null);

  useEffect(() => {
    if (restoredFor.current === sessionId) return; // already handled this entry
    if (!session || !allModels) return; // wait for both queries

    const modelId = session.model_id;
    const providerId = session.provider_id;

    // One-shot regardless of outcome below — don't retry on later renders.
    restoredFor.current = sessionId;

    // New / legacy session with no remembered model: keep the global default.
    if (!modelId || !providerId) return;

    // Only restore a model that's still available for that provider.
    const exists = allModels.some(
      (m) => m.id === modelId && m.provider_id === providerId,
    );
    if (!exists) return;

    const store = useSettingsStore.getState();
    const bucket = providerBucketFor(providerId);
    if (store.activeProvider !== bucket) store.setActiveProvider(bucket);
    if (
      store.selectedModel !== modelId ||
      store.selectedProviderId !== providerId
    ) {
      store.setSelectedModel(modelId, providerId);
    }
  }, [session, allModels, sessionId]);
}
