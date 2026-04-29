"use client";

import { useTranslation } from "react-i18next";
import { useChatStore } from "@/stores/chat-store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function formatTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) {
    const v = n / 1_000;
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  const v = n / 1_000_000;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)}M`;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Real-time session usage indicator shown in the chat header.
 * Surfaces cumulative token consumption (and cost when the provider returns
 * pricing) so users can judge how much a session has consumed without
 * digging into the Settings → Usage tab.
 *
 * Renders nothing until at least one step_finish event has been observed.
 */
export function SessionStats() {
  const { t } = useTranslation("chat");
  const usage = useChatStore((s) => s.sessionUsage);

  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.reasoningTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;

  if (totalTokens === 0 && usage.cost === null) {
    return null;
  }

  const tokensLabel = `${formatTokens(totalTokens)} tok`;
  const costLabel = usage.cost !== null ? `≈${formatCost(usage.cost)}` : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors cursor-default whitespace-nowrap shrink-0"
          aria-label={t("sessionStats.aria", "Session usage")}
        >
          <span className="tabular-nums">{tokensLabel}</span>
          {costLabel && (
            <>
              <span className="opacity-40">·</span>
              <span className="tabular-nums">{costLabel}</span>
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="pointer-events-none w-[240px] rounded-lg border border-[var(--border-default)] bg-[var(--surface-tertiary)] px-3 py-2.5 shadow-[var(--shadow-md)]"
      >
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
            {t("sessionStats.title", "Session usage")}
          </div>
          <div className="space-y-1 text-[12px] text-[var(--text-primary)]">
            <UsageRow
              label={t("sessionStats.input", "Input")}
              value={formatTokens(usage.inputTokens)}
            />
            <UsageRow
              label={t("sessionStats.output", "Output")}
              value={formatTokens(usage.outputTokens)}
            />
            {usage.reasoningTokens > 0 && (
              <UsageRow
                label={t("sessionStats.reasoning", "Reasoning")}
                value={formatTokens(usage.reasoningTokens)}
              />
            )}
            {(usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) && (
              <UsageRow
                label={t("sessionStats.cache", "Cache (r/w)")}
                value={`${formatTokens(usage.cacheReadTokens)} / ${formatTokens(
                  usage.cacheWriteTokens,
                )}`}
              />
            )}
          </div>
          {usage.cost !== null && (
            <div className="border-t border-[var(--border-subtle)] pt-2">
              <UsageRow
                label={t("sessionStats.cost", "Estimated cost")}
                value={`≈${formatCost(usage.cost)}`}
                emphasize
              />
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)]">
                {t(
                  "sessionStats.costNote",
                  "Estimated from provider pricing.",
                )}
              </div>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function UsageRow({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span
        className={`tabular-nums ${emphasize ? "font-semibold" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
