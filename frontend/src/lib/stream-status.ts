import type { SessionStreamState } from "@/stores/connection-store";
import type { SessionStreamStatus } from "@/stores/connection-store";

export interface StreamStatusPresentation {
  key:
    | "streamReconnecting"
    | "streamRetrying"
    | "streamRetryingIn"
    | "streamConnectionLost";
  seconds: number;
  attempt?: number;
  maxRetries?: number;
  reason?: string | null;
}

/** Convert transport/provider state into the small set of visible UX states. */
export function getStreamStatusPresentation(
  state: SessionStreamState | undefined,
): StreamStatusPresentation | null {
  if (!state) return null;
  if (state.status === "reconnecting") {
    return { key: "streamReconnecting", seconds: 0 };
  }
  if (state.status === "disconnected") {
    return { key: "streamConnectionLost", seconds: 0 };
  }
  if (state.status !== "retrying") return null;

  const retry = state.retry;
  const seconds = retry ? Math.ceil(Math.max(0, retry.delayMs) / 1_000) : 0;
  return {
    key: seconds > 0 ? "streamRetryingIn" : "streamRetrying",
    seconds,
    ...(retry && retry.attempt > 0
      ? {
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          reason: retry.reason,
        }
      : {}),
  };
}

/**
 * A background stream must never make the foreground task look offline.
 * Tasks without a live stream are idle, regardless of another Session's SSE.
 */
export function getTaskConnectionStatus(
  state: SessionStreamState | undefined,
): SessionStreamStatus | "idle" {
  return state?.status ?? "idle";
}
