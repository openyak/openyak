"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";
import { getTaskSubagentsRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { SubagentRun } from "@/types/subagent";

function compactRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";

  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

interface SubagentRowProps {
  run: SubagentRun;
  parentSessionId: string;
  active?: boolean;
  previewLineCount?: 1 | 2;
}

export function SubagentRow({
  run,
  parentSessionId,
  active = false,
  previewLineCount = 1,
}: SubagentRowProps) {
  const { t } = useTranslation("common");
  const { t: tChat } = useTranslation("chat");
  const summary = run.summary?.replace(/\s+/g, " ").trim() ?? "";
  const error = run.error?.replace(/\s+/g, " ").trim() ?? "";
  const statusLabel =
    run.status === "pending"
      ? t("subagentsThinking")
      : run.status === "running"
        ? t("subagentsWorking")
        : run.status === "waiting_input"
          ? tChat("statusWaitingInput")
          : run.status === "completed"
            ? tChat("statusCompleted")
            : run.status === "failed"
              ? tChat("statusFailed")
              : tChat("statusCancelled");
  const activeFallback = active ? statusLabel : "";
  const preview = summary || error || activeFallback;
  const trailing =
    summary && run.last_message_at
      ? compactRelativeTime(run.last_message_at)
      : "";

  return (
    <Link
      href={getTaskSubagentsRoute(parentSessionId, run.session_id)}
      className="group/subagent flex min-h-8 w-full items-start rounded-md px-1 py-1 text-start transition-colors hover:bg-[var(--surface-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
      aria-label={`${t("openSubagent", { title: run.title })}. ${statusLabel}`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-[14px] leading-5">
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
            {run.title}
          </span>
          {trailing && (
            <time
              dateTime={run.last_message_at ?? undefined}
              className="shrink-0 text-[14px] leading-5 text-[var(--text-tertiary)]"
            >
              {trailing}
            </time>
          )}
        </span>
        {preview && (
          <span
            className={cn(
              "block text-[14px] leading-5 text-[var(--text-secondary)]",
              previewLineCount === 2 ? "line-clamp-2" : "truncate",
              error && !summary && "text-[var(--color-destructive)]",
            )}
          >
            {preview}
          </span>
        )}
      </span>
    </Link>
  );
}
