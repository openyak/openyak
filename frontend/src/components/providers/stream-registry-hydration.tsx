"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { getChatRoute } from "@/lib/routes";
import { useChatStore } from "@/stores/chat-store";
import { startStream, isStreamActive } from "@/lib/session-stream-registry";
import { NAVIGATE_TO_SESSION_EVENT, type NavigateToSessionDetail } from "@/lib/background-notify";

/**
 * On app boot, ask the backend which generations are still running and
 * re-attach SSE streams for each so the user comes back to a fully-populated
 * sidebar after closing and reopening the app (or after a backend restart).
 *
 * Idempotent — `startStream` skips sessions already in the registry, and the
 * `last_event_id` replay machinery on the server fills in any events the
 * client missed while the registry was empty.
 */
export function StreamRegistryHydration() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        const jobs = await api.get<Array<{ stream_id: string; session_id: string; needs_input?: boolean }>>(
          API.CHAT.ACTIVE,
        );
        if (cancelled) return;
        const chatState = useChatStore.getState();
        for (const job of jobs) {
          if (isStreamActive(job.session_id)) continue;
          chatState.startGeneration(job.session_id, job.stream_id);
          void startStream(job.session_id, job.stream_id);
        }
      } catch {
        // Backend unreachable on boot is handled elsewhere (OfflineOverlay);
        // hydration is best-effort.
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Soft-route to a session when the user clicks a background-finish
  // notification. The notification handler dispatches a CustomEvent so the
  // module-level registry stays decoupled from React, and we pick it up
  // here where the Next router is available.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NavigateToSessionDetail>).detail;
      if (!detail?.sessionId) return;
      router.push(getChatRoute(detail.sessionId));
    };
    window.addEventListener(NAVIGATE_TO_SESSION_EVENT, handler);
    return () => window.removeEventListener(NAVIGATE_TO_SESSION_EVENT, handler);
  }, [router]);

  return null;
}
