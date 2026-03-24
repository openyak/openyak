"use client";

import { Info } from "lucide-react";
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMessageStats } from "@/hooks/use-message-stats";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore } from "@/stores/settings-store";

interface ContextIndicatorProps {
  sessionId: string;
}

export function ContextIndicator({ sessionId }: ContextIndicatorProps) {
  const { t } = useTranslation('chat');
  const { data: models } = useModels();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const maxContext = models?.find((m) => m.id === selectedModel)?.capabilities.max_context;
  const { data: stats } = useMessageStats(sessionId, maxContext);

  // Don't show if no stats or no tokens tracked yet
  if (!stats || stats.totalTokens === 0) return null;

  const getStatusColor = () => {
    if (stats.percentage >= 90) return "var(--color-destructive)";
    if (stats.percentage >= 75) return "var(--color-warning)";
    return "var(--text-tertiary)";
  };

  const percentage = Math.round(stats.percentage);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--surface-secondary)] transition-colors text-[11px] font-medium text-[var(--text-tertiary)]">
          {stats.hasCompaction && (
            <Info className="h-3.5 w-3.5 text-[var(--color-warning)]" />
          )}
          <span>{percentage}%</span>
          <div className="w-12 h-1 bg-[var(--surface-tertiary)] rounded-full overflow-hidden">
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${stats.percentage}%`,
                backgroundColor: getStatusColor(),
              }}
            />
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" sideOffset={8} className="max-w-xs">
        <div className="space-y-1.5">
          <div className="font-medium">{t('contextUsage')}</div>
          <div className="text-xs text-[var(--text-secondary)] space-y-0.5">
            <div>{t('contextPercent', { percent: percentage })}</div>
            {stats.hasCompaction && (
              <div className="text-[var(--color-warning)] mt-1">
                ⚠ {t('contextCompressed')}
              </div>
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
