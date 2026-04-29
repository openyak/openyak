"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, queryKeys } from "@/lib/constants";
import { useMessageStats } from "@/hooks/use-message-stats";
import { useModels } from "@/hooks/use-models";
import { useChatStore } from "@/stores/chat-store";
import { useSettingsStore } from "@/stores/settings-store";

interface ContextIndicatorProps {
  sessionId: string;
}

function formatTokenCompact(count: number): string {
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    const rounded = value.toFixed(1);
    return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded}M`;
  }
  if (count >= 1_000) {
    const value = count / 1_000;
    const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1);
    return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded}k`;
  }
  return count.toString();
}

function ProgressRing({ percentage, color }: { percentage: number; color: string }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(percentage, 100));
  const dashOffset = circumference * (1 - progress / 100);

  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0">
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="var(--surface-tertiary)"
        strokeWidth="2.5"
      />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

export function ContextIndicator({ sessionId }: ContextIndicatorProps) {
  const { t } = useTranslation('chat');
  const queryClient = useQueryClient();
  const { data: models } = useModels();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const isGenerating = useChatStore((s) => s.isGenerating);
  const isChatCompacting = useChatStore((s) => s.isCompacting);
  const startCompactionStream = useChatStore((s) => s.startCompactionStream);
  const selectedModelInfo = models?.find((m) => m.id === selectedModel);
  const effectiveContext = selectedModelInfo?.metadata?.effective_context_window;
  const maxContext =
    typeof effectiveContext === "number" && effectiveContext > 0
      ? Math.min(effectiveContext, selectedModelInfo?.capabilities.max_context ?? effectiveContext)
      : selectedModelInfo?.capabilities.max_context;
  const { data: stats } = useMessageStats(sessionId, maxContext);
  const [isStartingCompact, setIsStartingCompact] = useState(false);
  const meetsManualCompactionThreshold = !!stats && stats.percentage >= 50;

  const handleManualCompact = useCallback(async () => {
    if (isGenerating || isChatCompacting || isStartingCompact || !meetsManualCompactionThreshold) return;

    setIsStartingCompact(true);
    try {
      const result = await api.post<{
        stream_id: string;
        session_id: string;
      }>(API.CHAT.COMPACT, { session_id: sessionId, model_id: selectedModel });
      startCompactionStream(result.stream_id, result.session_id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }),
      ]);
    } catch (error) {
      toast.error(errorToMessage(error, t('contextCompactError')));
    } finally {
      setIsStartingCompact(false);
    }
  }, [isChatCompacting, isGenerating, isStartingCompact, meetsManualCompactionThreshold, queryClient, selectedModel, sessionId, startCompactionStream, t]);

  // Don't show if no stats or no tokens tracked yet
  if (!stats || stats.totalTokens === 0) return null;

  const getStatusColor = () => {
    if (stats.percentage >= 90) return "var(--color-destructive)";
    if (stats.percentage >= 75) return "var(--color-warning)";
    return "var(--text-tertiary)";
  };

  const usedCompact = formatTokenCompact(stats.totalTokens);
  const limitCompact = formatTokenCompact(maxContext ?? 0);
  const statusColor = getStatusColor();
  const isDisabled = isGenerating || isChatCompacting || isStartingCompact || !meetsManualCompactionThreshold;
  const compactHint = isGenerating
    ? t('contextCompactBusy')
    : isChatCompacting
      ? t('contextCompactingNow')
      : meetsManualCompactionThreshold
        ? t('contextCompactNow')
        : t('contextCompactThreshold');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-[var(--radius)] disabled:pointer-events-auto disabled:opacity-100"
          aria-label={meetsManualCompactionThreshold ? t('contextCompactNow') : t('contextCompactThreshold')}
          aria-disabled={isDisabled}
          onClick={handleManualCompact}
        >
          {isStartingCompact ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin text-[var(--text-tertiary)]" />
          ) : (
            <ProgressRing percentage={stats.percentage} color={statusColor} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" sideOffset={8} className="pointer-events-none w-[220px] rounded-lg border border-[var(--border-default)] bg-[var(--surface-tertiary)] px-3 py-2.5 shadow-[var(--shadow-md)]">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="w-full space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">{t('contextWindow')}</div>
            <div className="text-[13px] leading-tight font-semibold text-[var(--text-primary)]">
              {t('contextTokensUsed', { used: usedCompact, total: limitCompact })}
            </div>
          </div>
          <div className="max-w-[180px] text-[12px] leading-snug text-[var(--text-primary)]">
            {t('contextAutoCompact')}
          </div>
          <div className="max-w-[180px] text-[11px] text-[var(--text-secondary)]">
            {compactHint}
          </div>
          {stats.hasCompaction && (
            <div className="max-w-[180px] text-[11px] text-[var(--color-warning)]">
              {t('contextCompressed')}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
