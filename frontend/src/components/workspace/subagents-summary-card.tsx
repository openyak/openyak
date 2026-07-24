"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";
import { useSubagents } from "@/hooks/use-subagents";
import { getTaskSubagentsRoute } from "@/lib/routes";

interface SubagentsSummaryCardProps {
  parentSessionId: string;
}

export function SubagentsSummaryCard({
  parentSessionId,
}: SubagentsSummaryCardProps) {
  const { t } = useTranslation("common");
  const { data, isPlaceholderData } = useSubagents(parentSessionId);
  const counts = data?.counts ?? { active: 0, done: 0, total: 0 };

  if (isPlaceholderData || counts.total === 0) return null;

  const waitingCount =
    data?.active.filter((run) => run.status === "waiting_input").length ?? 0;
  const workingCount = Math.max(0, counts.active - waitingCount);
  const primaryLabel =
    waitingCount > 0
      ? t("subagentsWaitingCount", { count: waitingCount })
      : workingCount > 0
        ? t("subagentsWorkingCount", { count: workingCount })
      : t("subagentsDoneOnlyCount", { count: counts.done });
  const activeAccessibleLabel = [
    waitingCount > 0
      ? t("subagentsWaitingCount", { count: waitingCount })
      : null,
    workingCount > 0
      ? t("subagentsWorkingCount", { count: workingCount })
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Link
      href={getTaskSubagentsRoute(parentSessionId)}
      className="block border-t border-[var(--border-subtle)] px-4 pb-3 pt-4 transition-colors hover:bg-[var(--surface-tertiary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
      aria-label={`${t("openSubagents")}: ${activeAccessibleLabel || t("subagentsWorkingCount", { count: 0 })}, ${t("subagentsDoneOnlyCount", { count: counts.done })}`}
    >
      <h2 className="block text-base font-normal text-[var(--text-tertiary)]">
        {t("subagents")}
      </h2>
      <span className="mt-3 flex min-w-0 items-center gap-2">
        <span className="truncate text-base text-[var(--text-secondary)]">
          {primaryLabel}
        </span>
        {counts.active > 0 && counts.done > 0 && (
          <span className="ml-auto shrink-0 text-xs text-[var(--text-tertiary)]">
            {t("subagentsDoneOnlyCount", { count: counts.done })}
          </span>
        )}
      </span>
    </Link>
  );
}
