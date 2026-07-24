"use client";

import { useTranslation } from "react-i18next";
import { getStreamStatusPresentation } from "@/lib/stream-status";
import { useConnectionStore } from "@/stores/connection-store";

interface StreamStatusLineProps {
  sessionId: string;
  className?: string;
  contentClassName?: string;
}

/** Quiet, task-scoped transport/provider recovery status. */
export function StreamStatusLine({
  sessionId,
  className = "px-4 pb-1",
  contentClassName = "max-w-3xl",
}: StreamStatusLineProps) {
  const { t } = useTranslation("chat");
  const streamState = useConnectionStore(
    (state) => state.sessionStates[sessionId],
  );
  const streamStatus = getStreamStatusPresentation(streamState);

  if (!streamStatus) return null;

  return (
    <div
      className={`shrink-0 ${className}`}
      role="status"
      aria-live="polite"
      title={streamStatus.reason ?? undefined}
    >
      <div
        className={`mx-auto flex w-full items-center gap-2 text-[11px] leading-4 text-[var(--text-tertiary)] ${contentClassName}`}
      >
        <span
          className="size-1.5 shrink-0 rounded-full bg-[var(--text-tertiary)] animate-[pulse-dot_1.4s_ease-in-out_infinite]"
          aria-hidden="true"
        />
        <span>
          {t(streamStatus.key, { seconds: streamStatus.seconds })}
          {streamStatus.attempt != null &&
            streamStatus.maxRetries != null &&
            streamStatus.maxRetries > 0 && (
              <span className="ml-1.5 text-[var(--text-quaternary)]">
                {t("streamRetryAttempt", {
                  attempt: streamStatus.attempt,
                  maxRetries: streamStatus.maxRetries,
                })}
              </span>
            )}
        </span>
      </div>
    </div>
  );
}
