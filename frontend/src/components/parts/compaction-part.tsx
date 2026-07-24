"use client";

import { motion } from "framer-motion";
import { Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CompactionPart as CompactionPartType } from "@/types/message";

interface CompactionPartProps {
  data?: CompactionPartType;
}

export function CompactionPart({ data }: CompactionPartProps) {
  const { t } = useTranslation("chat");
  const phases = data?.phases ?? [];
  const isInProgress =
    phases.length > 0 && data?.compactionStatus !== "completed";
  const completed = phases.filter(
    (phase) => phase.status === "completed",
  ).length;
  const activePhase = phases.find((phase) => phase.status === "started");
  const label = t(
    isInProgress ? "conversationOptimizing" : "conversationOptimized",
  );
  const activePhaseLabel =
    activePhase?.phase === "prune"
      ? t("contextCompactingPrune")
      : activePhase?.phase === "summarize"
        ? activePhase.chars
          ? t("contextCompactingSummarizeProgress", {
              chars: activePhase.chars,
            })
          : t("contextCompactingSummarize")
        : null;
  const progressLabel =
    isInProgress && phases.length > 0
      ? t("compactionProgress", {
          completed,
          total: phases.length,
        })
      : null;
  const accessibleLabel = [label, activePhaseLabel, progressLabel]
    .filter(Boolean)
    .join(". ");

  return (
    <motion.div
      role="status"
      aria-live="polite"
      aria-label={accessibleLabel}
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="flex min-h-9 min-w-0 items-center gap-2 py-1 text-[13px] leading-7 text-[var(--text-tertiary)]"
    >
      <Minimize2
        className={
          isInProgress
            ? "size-3.5 shrink-0 animate-pulse text-[var(--text-secondary)]"
            : "size-3.5 shrink-0 text-[var(--text-tertiary)]"
        }
        aria-hidden="true"
      />
      <span className={isInProgress ? "shimmer-text" : undefined}>
        {label}
      </span>
      {progressLabel && (
        <span
          aria-hidden="true"
          className="shrink-0 text-[11px] tabular-nums text-[var(--text-quaternary)]"
        >
          {completed}/{phases.length}
        </span>
      )}
    </motion.div>
  );
}
