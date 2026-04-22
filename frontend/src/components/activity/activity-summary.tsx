"use client";

import { CheckCircle2, ChevronRight, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { OpenYakLogo } from "@/components/ui/openyak-logo";
import { useActivityStore, type ActivityData } from "@/stores/activity-store";

interface ActivitySummaryProps {
  data: ActivityData;
}

export function ActivitySummary({ data }: ActivitySummaryProps) {
  const { t } = useTranslation("chat");
  const toggleForMessage = useActivityStore((s) => s.toggleForMessage);
  const isActiveOpen = useActivityStore(
    (s) => s.isOpen && !!data.sourceKey && s.activeKey === data.sourceKey,
  );

  const hasReasoning = data.reasoningTexts.length > 0;
  const hasTools = data.toolParts.length > 0;
  const lastStepFinish = [...data.stepParts]
    .reverse()
    .find((part) => part.type === "step-finish");
  const hasRunningTools = data.toolParts.some(
    (tool) => tool.state.status === "running" || tool.state.status === "pending",
  );
  const isCompleted =
    (!!lastStepFinish && lastStepFinish.reason !== "tool_use") ||
    (!!data.hasVisibleOutput && !hasRunningTools);

  if (!hasReasoning && !hasTools) return null;

  const parts: string[] = [];
  if (isCompleted) {
    parts.push(t("done"));
  } else if (hasReasoning) {
    parts.push(
      data.thinkingDuration != null
        ? t("thoughtFor", { duration: `${data.thinkingDuration}s` })
        : t("reasoning"),
    );
  }
  if (hasTools) {
    const count = data.toolParts.length;
    parts.push(t("toolCallCount", { count }));
  }

  return (
    <button
      type="button"
      onClick={() => data.sourceKey && toggleForMessage(data.sourceKey, data)}
      className="flex items-center gap-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors py-1.5 group"
    >
      {isCompleted ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--tool-completed)]" />
      ) : hasReasoning ? (
        <OpenYakLogo size={14} />
      ) : (
        <Wrench className="h-3.5 w-3.5" />
      )}
      <span>{parts.join(" · ")}</span>
      <ChevronRight
        className={`h-3 w-3 transition-transform duration-200 ${isActiveOpen ? "rotate-90" : ""}`}
      />
    </button>
  );
}
