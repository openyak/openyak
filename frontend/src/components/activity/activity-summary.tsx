"use client";

import { useEffect, useRef } from "react";
import {
  CheckCircle2,
  ChevronRight,
  GitBranch,
  Globe2,
  Pencil,
  Search,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { OpenYakLogo } from "@/components/ui/openyak-logo";
import {
  formatWorkActivitySummary,
  summarizeWorkActivity,
} from "@/lib/work-event-timeline";
import { useActivityStore, type ActivityData } from "@/stores/activity-store";

interface ActivitySummaryProps {
  data: ActivityData;
  /** A finished timeline batch can be complete while the parent message still streams. */
  completed?: boolean;
}

export function ActivitySummary({ data, completed }: ActivitySummaryProps) {
  const { t, i18n } = useTranslation("chat");
  const toggleForMessage = useActivityStore((s) => s.toggleForMessage);
  const isActiveOpen = useActivityStore(
    (s) => s.isOpen && !!data.sourceKey && s.activeKey === data.sourceKey,
  );
  const isPanelOpen = useActivityStore((s) => s.isOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasExpandedRef = useRef(false);

  useEffect(() => {
    if (wasExpandedRef.current && !isPanelOpen) {
      triggerRef.current?.focus();
    }
    wasExpandedRef.current = isActiveOpen;
  }, [isActiveOpen, isPanelOpen]);

  const hasReasoning = data.reasoningTexts.length > 0;
  const hasTools = data.toolParts.length > 0;
  const lastStepFinish = [...data.stepParts]
    .reverse()
    .find((part) => part.type === "step-finish");
  const hasRunningTools = data.toolParts.some(
    (tool) => tool.state.status === "running" || tool.state.status === "pending",
  );
  const isCompleted =
    completed ??
    ((!!lastStepFinish && lastStepFinish.reason !== "tool_use") ||
      (!!data.hasVisibleOutput && !hasRunningTools));

  if (!hasReasoning && !hasTools) return null;

  const summaryItems = summarizeWorkActivity(data.toolParts);
  const readableSummary = isCompleted
    ? formatWorkActivitySummary(
        summaryItems,
        i18n.resolvedLanguage ?? i18n.language,
      )
    : "";
  const parts: string[] = [];
  if (readableSummary) {
    parts.push(readableSummary);
  } else if (isCompleted) {
    parts.push(t("done"));
  } else if (hasReasoning) {
    parts.push(
      data.thinkingDuration != null
        ? t("thoughtFor", { duration: `${data.thinkingDuration}s` })
        : t("reasoning"),
    );
  }
  if (hasTools && !readableSummary) {
    const count = data.toolParts.length;
    parts.push(t("toolCallCount", { count }));
  }

  const primaryCategory = summaryItems[0]?.category;
  const SummaryIcon =
    primaryCategory === "usedBrowser"
      ? Globe2
      : primaryCategory === "searchedFiles"
        ? Search
        : primaryCategory === "coordinatedAgents"
          ? GitBranch
          : primaryCategory === "loadedTools"
            ? Wrench
            : Pencil;
  const label = parts.join(" · ");
  const icon = readableSummary ? (
    <SummaryIcon className="h-3.5 w-3.5 shrink-0" />
  ) : isCompleted ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--tool-completed)]" />
      ) : hasReasoning ? (
        <OpenYakLogo size={14} />
      ) : (
        <Wrench className="h-3.5 w-3.5" />
  );

  const content = (
    <>
      {icon}
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </>
  );

  if (!data.sourceKey) {
    return (
      <div
        className="flex min-h-8 max-w-full items-center gap-2 py-1.5 text-[13px] leading-5 text-[var(--text-tertiary)]"
        role="status"
      >
        {content}
      </div>
    );
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => toggleForMessage(data.sourceKey!, data)}
      aria-label={`${t("activity")}: ${label}`}
      aria-expanded={isActiveOpen}
      aria-controls="activity-panel"
      className="group flex min-h-8 max-w-full items-center gap-2 py-1.5 text-left text-[13px] leading-5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
    >
      {content}
      <ChevronRight
        className={`h-3 w-3 shrink-0 opacity-0 transition-[transform,opacity] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 ${isActiveOpen ? "rotate-90 opacity-100" : ""}`}
      />
    </button>
  );
}
