"use client";

import { create } from "zustand";
import type { SSEConnectionStatus } from "@/lib/sse";

export type SessionStreamStatus = SSEConnectionStatus | "retrying";

export interface SessionRetryState {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  reason: string | null;
}

export interface SessionStreamState {
  status: SessionStreamStatus;
  /** Short, presentation-ready status copy for this Session. */
  message: string | null;
  /** Structured provider-retry details for richer task-local presentation. */
  retry?: SessionRetryState;
}

interface ConnectionStore {
  /** Current SSE connection status */
  status: SSEConnectionStatus | "idle";
  /** Connection/model retry state keyed by Session, for task-local UX. */
  sessionStates: Record<string, SessionStreamState>;
  /** Whether the backend health check passed */
  backendReachable: boolean;
  setStatus: (status: SSEConnectionStatus | "idle") => void;
  setSessionState: (sessionId: string, state: SessionStreamState) => void;
  clearSessionState: (sessionId: string) => void;
  setBackendReachable: (reachable: boolean) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: "idle",
  sessionStates: {},
  backendReachable: true,
  setStatus: (status) => set({ status }),
  setSessionState: (sessionId, state) =>
    set((current) => ({
      sessionStates: {
        ...current.sessionStates,
        [sessionId]: state,
      },
    })),
  clearSessionState: (sessionId) =>
    set((current) => {
      if (!(sessionId in current.sessionStates)) return current;
      const sessionStates = { ...current.sessionStates };
      delete sessionStates[sessionId];
      return { sessionStates };
    }),
  setBackendReachable: (reachable) => set({ backendReachable: reachable }),
}));
