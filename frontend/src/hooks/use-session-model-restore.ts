"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore } from "@/stores/settings-store";
import { providerBucket } from "@/lib/providers";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { SessionResponse } from "@/types/session";

/**
 * Per-session model memory: restore the model a session was last using when
 * the user enters it.
 *
 * The backend persists `model_id` / `provider_id` on the session row (set on
 * every prompt). On entry we set the global selector to that model, with two
 * guards:
 *
 *   1. **Once per visit.** Within a single visit we restore only once, so a
 *      manual model switch made *while in* the session isn't fought on every
 *      re-render. Note this is per-visit, not per-session-forever: re-entering
 *      a session (A → B → A) restores its stored model again — that's required
 *      for the selector to track the session you're viewing, so an unsent
 *      manual change made just before navigating away is not preserved.
 *   2. **Only if the model still exists.** If the stored model was removed
 *      (provider disconnected, model deprecated), we leave the current
 *      selection alone rather than stranding the selector on a dead model.
 *
 * Setting `activeProvider` to the model's bucket keeps the dropdown's
 * auto-select from immediately overriding the restore. Sessions with no stored
 * model (brand-new or pre-feature) fall through to the global default.
 */
export function useSessionModelRestore(sessionId: string): void {
  const { data: allModels } = useModels();
  const { data: session } = useQuery({
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: () => api.get<SessionResponse>(API.SESSIONS.DETAIL(sessionId)),
    staleTime: 30_000,
  });

  // The session we've already restored for the current visit. Compared against
  // the live sessionId, so re-entering a session restores it again.
  const restoredFor = useRef<string | null>(null);

  useEffect(() => {
    if (restoredFor.current === sessionId) return; // already handled this visit

    // Wait until both queries have *populated*. An empty model list (`[]`) is
    // truthy but not yet usable; consuming the one-shot against it would strand
    // the session on the global default once models finish loading.
    if (!session || !allModels || allModels.length === 0) return;

    const modelId = session.model_id;
    const providerId = session.provider_id;

    // One-shot for this visit regardless of the outcome below.
    restoredFor.current = sessionId;

    // New / legacy session with no remembered model: keep the global default.
    if (!modelId || !providerId) return;

    // Only restore a model that's still available for that provider.
    const exists = allModels.some(
      (m) => m.id === modelId && m.provider_id === providerId,
    );
    if (!exists) return;

    const store = useSettingsStore.getState();
    const bucket = providerBucket(providerId);
    if (store.activeProvider !== bucket) store.setActiveProvider(bucket);
    if (
      store.selectedModel !== modelId ||
      store.selectedProviderId !== providerId
    ) {
      store.setSelectedModel(modelId, providerId);
    }
  }, [session, allModels, sessionId]);
}
