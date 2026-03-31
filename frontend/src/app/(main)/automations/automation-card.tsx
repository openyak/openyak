"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderOpen,
  History,
  Loader2,
  Pencil,
  Play,
  Repeat,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  useUpdateAutomation,
  useDeleteAutomation,
  useRunAutomation,
} from "@/hooks/use-automations";
import { queryKeys } from "@/lib/constants";
import { humanizeSchedule, relativeTime, formatTime } from "./helpers";
import { StatusBadge, RunHistoryPanel, DeleteConfirmDialog } from "./shared-ui";
import type { AutomationResponse, ScheduleConfig } from "@/types/automation";

export function AutomationCard({ automation: a, onEdit }: { automation: AutomationResponse; onEdit: (id: string) => void }) {
  const { t } = useTranslation("automations");
  const toggleMut = useUpdateAutomation();
  const deleteMut = useDeleteAutomation();
  const runMut = useRunAutomation();
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const handleRun = () => {
    runMut.mutate(a.id, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.all });
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      },
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    deleteMut.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) });
  };

  const isRunning = (a.last_run_status?.startsWith("running") ?? false) || runMut.isPending;

  return (
    <>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 hover:bg-[var(--surface-secondary)]/50 transition-colors">
        {/* Row 1: Name + actions */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onEdit(a.id)}>
            <span className="text-sm font-medium text-[var(--text-primary)] hover:underline">{a.name}</span>
            {a.description && (
              <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 truncate">{a.description}</p>
            )}
          </div>

          <Button
            variant="ghost" size="sm" className="h-7 gap-1.5 text-xs px-2"
            onClick={handleRun} disabled={isRunning}
          >
            {isRunning
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Play className="h-3.5 w-3.5" />}
            {isRunning ? t("statusRunning") : t("runNow")}
          </Button>

          <button
            type="button" className="inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
            onClick={() => onEdit(a.id)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>

          <Switch
            checked={a.enabled}
            onCheckedChange={(enabled) => toggleMut.mutate({ id: a.id, data: { enabled } })}
          />

          <button
            type="button"
            disabled={deleteMut.isPending}
            className={`inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
              deleteMut.isPending
                ? "opacity-50 cursor-not-allowed text-[var(--text-tertiary)]"
                : "text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--surface-secondary)]"
            }`}
            onClick={() => setDeleteTarget({ id: a.id, name: a.name })}
          >
            {deleteMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Row 2: Schedule + status meta */}
        <div className="flex items-center gap-3 mt-2 text-[11px] text-[var(--text-tertiary)]">
          <span className="inline-flex items-center gap-1">
            {a.loop_max_iterations ? (
              <>
                <Repeat className="h-3 w-3" />
                {t("loopIterations", { n: a.loop_max_iterations })}
              </>
            ) : (
              <>
                <Clock className="h-3 w-3" />
                {a.schedule_config ? humanizeSchedule(a.schedule_config as ScheduleConfig, t) : "—"}
              </>
            )}
          </span>

          {a.workspace && (
            <span className="inline-flex items-center gap-1 truncate max-w-[180px]" title={a.workspace}>
              <FolderOpen className="h-3 w-3 shrink-0" />
              {a.workspace.replace(/\\/g, "/").split("/").pop()}
            </span>
          )}

          {a.next_run_at && !isRunning && (
            <span>{t("nextRun")}: {formatTime(a.next_run_at)}</span>
          )}

          {a.run_count > 0 && (
            <span>{t("runCount")} {a.run_count} {t("times")}</span>
          )}

          {a.run_count > 0 && (
            <button
              type="button"
              onClick={() => setShowHistory(!showHistory)}
              className="inline-flex items-center gap-0.5 ml-auto text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <History className="h-3 w-3" />
              {t("history")}
              {showHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          )}
        </div>

        {/* Row 3: Last run result */}
        {a.last_run_at && (
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--border-default)]/50">
            <StatusBadge status={a.last_run_status} sessionId={a.last_session_id} t={t} />
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {relativeTime(a.last_run_at, t)}
            </span>
            {a.last_session_id && a.last_run_status !== "running" && (
              <Link
                href={`/c/${a.last_session_id}`}
                className="ml-auto text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] inline-flex items-center gap-0.5"
              >
                {t("viewResult")}
                <ArrowUpRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        )}

        {/* Row 4: Expandable run history */}
        {showHistory && (
          <div className="mt-2 pt-2 border-t border-[var(--border-default)]/50">
            <RunHistoryPanel automationId={a.id} t={t} />
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <DeleteConfirmDialog
          name={deleteTarget.name}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          isPending={deleteMut.isPending}
          t={t}
        />
      )}
    </>
  );
}
