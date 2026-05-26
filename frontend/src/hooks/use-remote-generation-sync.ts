"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import { useChatStore } from "@/stores/chat-store";
import { startStream, isStreamActive } from "@/lib/session-stream-registry";

/**
 * Poll for active generations in the current session.
 *
 * When another client (e.g. mobile) starts a generation in a session the PC
 * is viewing, the PC has no way to discover the stream_id — it only sets a
 * streamId when *it* initiates a prompt.
 *
 * This hook polls `GET /api/chat/active` every few seconds. When it finds an
 * active generation for the current session that the local stream registry
 * isn't already tracking, it attaches a stream and flips the bucket into
 * generating state.
 */
const POLL_INTERVAL = 5_000;

export function useRemoteGenerationSync(sessionId: string | undefined) {
  const queryClient = useQueryClient();
  const knownStreamIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (!active) return;

      try {
        const jobs = await api.get<{ stream_id: string; session_id: string }[]>(
          API.CHAT.ACTIVE,
        );

        if (!active) return;

        const match = jobs.find((j) => j.session_id === sessionId);
        const chatState = useChatStore.getState();
        const bucket = chatState.sessions[sessionId];

        if (match) {
          // Skip if we're already tracking this exact stream (either locally
          // initiated or attached on a previous poll).
          if (bucket?.streamId === match.stream_id || isStreamActive(sessionId)) {
            knownStreamIdRef.current = match.stream_id;
          } else if (knownStreamIdRef.current !== match.stream_id) {
            knownStreamIdRef.current = match.stream_id;

            await queryClient.invalidateQueries({
              queryKey: queryKeys.messages.list(sessionId),
            });

            chatState.startGeneration(sessionId, match.stream_id);
            void startStream(sessionId, match.stream_id);
          }
        } else {
          // No active generation server-side. If we were tracking one from a
          // remote client, refetch messages to pick up the final state.
          if (knownStreamIdRef.current) {
            knownStreamIdRef.current = null;
            if (!bucket?.isGenerating) {
              queryClient.invalidateQueries({
                queryKey: queryKeys.messages.list(sessionId),
              });
            }
          }
        }
      } catch {
        // ignore polling errors
      }

      if (active) {
        timer = setTimeout(poll, POLL_INTERVAL);
      }
    };

    poll();

    return () => {
      active = false;
      knownStreamIdRef.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, queryClient]);
}
