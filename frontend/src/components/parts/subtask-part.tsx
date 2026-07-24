"use client";

import { useId } from "react";
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleEllipsis,
  GitBranch,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { getChatRoute, getTaskSubagentsRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { AgentRunStatus } from "@/types/message";
import type { SubtaskPart as SubtaskPartType } from "@/types/message";

interface SubtaskPartProps {
  data: SubtaskPartType;
  parentSessionId?: string | null;
}

export function SubtaskPart({ data, parentSessionId }: SubtaskPartProps) {
  const { t } = useTranslation("chat");
  const descriptionId = useId();
  const statusLabels: Record<AgentRunStatus, string> = {
    pending: t("statusPending"),
    running: t("statusRunning"),
    waiting_input: t("statusWaitingInput"),
    completed: t("statusCompleted"),
    failed: t("statusFailed"),
    cancelled: t("statusCancelled"),
  };
  const status = data.status ?? null;
  const statusLabel = status ? statusLabels[status] : null;
  const parentTaskId = data.parent_id ?? parentSessionId;
  const accessibleDescription = data.error || data.description;
  const lifecycleLabel = status
    ? t(
        status === "running"
          ? "agentLifecycleStarted"
          : status === "waiting_input"
            ? "agentLifecycleWaiting"
            : status === "completed"
              ? "agentLifecycleFinished"
              : status === "failed"
                ? "agentLifecycleFailed"
                : status === "cancelled"
                  ? "agentLifecycleCancelled"
                  : "agentLifecyclePending",
      )
    : null;

  const statusIcon = (() => {
    const iconClass = "h-3.5 w-3.5 shrink-0";
    switch (status) {
      case "running":
        return (
          <LoaderCircle
            className={cn(iconClass, "animate-spin text-[var(--brand-primary)]")}
            aria-hidden="true"
          />
        );
      case "waiting_input":
        return (
          <CircleEllipsis
            className={cn(iconClass, "text-[var(--color-warning)]")}
            aria-hidden="true"
          />
        );
      case "completed":
        return (
          <CheckCircle2
            className={cn(iconClass, "text-[var(--tool-completed)]")}
            aria-hidden="true"
          />
        );
      case "failed":
        return (
          <TriangleAlert
            className={cn(iconClass, "text-[var(--tool-error)]")}
            aria-hidden="true"
          />
        );
      case "cancelled":
        return (
          <Ban
            className={cn(iconClass, "text-[var(--text-tertiary)]")}
            aria-hidden="true"
          />
        );
      case "pending":
        return (
          <Circle
            className={cn(iconClass, "text-[var(--text-quaternary)]")}
            aria-hidden="true"
          />
        );
      default:
        return (
          <GitBranch
            className={cn(iconClass, "text-[var(--text-quaternary)]")}
            aria-hidden="true"
          />
        );
    }
  })();

  return (
    <div
      role={status ? "status" : undefined}
      aria-live={status ? "polite" : undefined}
      aria-label={statusLabel ? `${data.title}: ${statusLabel}` : undefined}
      className="py-1"
    >
      <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <Link
          href={
            parentTaskId
              ? getTaskSubagentsRoute(parentTaskId, data.session_id)
              : getChatRoute(data.session_id)
          }
          aria-label={statusLabel ? `${data.title}, ${statusLabel}` : data.title}
          aria-describedby={accessibleDescription ? descriptionId : undefined}
          title={data.description || undefined}
          className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-primary)] px-2.5 text-[13px] font-medium leading-none text-[var(--text-secondary)] transition-[background-color,border-color,color] duration-150 hover:border-[var(--border-heavy)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {statusIcon}
          <span className="max-w-64 truncate">{data.title}</span>
        </Link>
        {lifecycleLabel && (
          <span className="text-[13px] leading-8 text-[var(--text-tertiary)]">
            {lifecycleLabel}
          </span>
        )}
        {data.error && (
          <span className="max-w-full truncate text-[12px] text-[var(--tool-error)]">
            {data.error}
          </span>
        )}
        {accessibleDescription && (
          <span id={descriptionId} className="sr-only">
            {accessibleDescription}
          </span>
        )}
      </div>
    </div>
  );
}
