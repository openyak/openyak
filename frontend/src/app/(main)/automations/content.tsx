"use client";

import { useState, useCallback } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderOpen,
  FolderSync,
  GitPullRequest,
  History,
  Loader2,
  Mail,
  Pencil,
  Play,
  Plus,
  Repeat,
  Sunrise,
  Timer,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  useAutomations,
  useCreateAutomation,
  useUpdateAutomation,
  useDeleteAutomation,
  useRunAutomation,
  useAutomationRuns,
  useTemplates,
  useCreateFromTemplate,
} from "@/hooks/use-automations";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore } from "@/stores/settings-store";
import { browseDirectory } from "@/lib/upload";
import { queryKeys } from "@/lib/constants";
import type {
  AutomationCreate,
  AutomationResponse,
  AutomationUpdate,
  ScheduleConfig,
  TaskRunResponse,
} from "@/types/automation";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

type Tab = "active" | "all" | "templates";

const ICON_MAP: Record<string, React.ElementType> = {
  Sunrise, CalendarCheck, Mail, GitPullRequest, FolderSync, Timer, Clock, Repeat,
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function humanizeSchedule(config: ScheduleConfig, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (config.type === "cron" && config.cron) return humanizeCron(config.cron, t);
  if (config.type === "interval") {
    const h = config.hours || 0;
    const m = config.minutes || 0;
    if (h > 0 && m > 0) return t("everyHM", { h, m });
    if (h > 0) return t("everyNHours", { n: h });
    if (m > 0) return t("everyNMinutes", { n: m });
  }
  return "—";
}

function humanizeCron(cron: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const parts = cron.split(" ");
  if (parts.length < 5) return cron;
  const [min, hour, , , dow] = parts;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const dayKeys: Record<string, string> = {
    "0": "sun", "1": "mon", "2": "tue", "3": "wed",
    "4": "thu", "5": "fri", "6": "sat", "7": "sun",
    "*": "everyday", "1-5": "weekdays", "0,6": "weekends",
  };
  const dayKey = dayKeys[dow];
  const dayLabel = dayKey ? t(`days.${dayKey}`) : dow;
  return `${dayLabel} ${time}`;
}

function relativeTime(iso: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("justNow");
  if (mins < 60) return t("minutesAgo", { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("hoursAgo", { n: hrs });
  const days = Math.floor(hrs / 24);
  return t("daysAgo", { n: days });
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return "";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return "<1s";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

/* ------------------------------------------------------------------ */
/* Shared input class                                                  */
/* ------------------------------------------------------------------ */

const inputClass = "w-full h-8 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]";

/* ------------------------------------------------------------------ */
/* Overlay backdrop                                                    */
/* ------------------------------------------------------------------ */

function DialogOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status badge                                                        */
/* ------------------------------------------------------------------ */

function StatusBadge({ status, sessionId, t }: { status: string | null; sessionId: string | null; t: (key: string, opts?: Record<string, unknown>) => string }) {
  if (!status) return null;

  const config: Record<string, { icon: React.ElementType; color: string; labelKey: string }> = {
    running: { icon: Loader2, color: "text-amber-400", labelKey: "statusRunning" },
    success: { icon: Check, color: "text-emerald-400", labelKey: "statusSuccess" },
    error:   { icon: XCircle, color: "text-red-400", labelKey: "statusError" },
    timeout: { icon: XCircle, color: "text-orange-400", labelKey: "statusTimeout" },
  };

  // Normalize loop running status (e.g. "running:3/10" → "running")
  const normalizedStatus = status.startsWith("running") ? "running" : status;
  const c = config[normalizedStatus];
  if (!c) return null;
  const Icon = c.icon;
  // Show loop progress in label (e.g. "Running 3/10")
  const loopMatch = status.match(/^running:(\d+\/\d+)$/);
  const loopSuffix = loopMatch ? ` ${loopMatch[1]}` : "";

  const badge = (
    <span className={`inline-flex items-center gap-1 text-[10px] ${c.color}`}>
      <Icon className={`h-3 w-3 ${normalizedStatus === "running" ? "animate-spin" : ""}`} />
      {t(c.labelKey)}{loopSuffix}
    </span>
  );

  if (normalizedStatus !== "running" && sessionId) {
    return (
      <Link
        href={`/c/${sessionId}`}
        className={`inline-flex items-center gap-1 text-[10px] ${c.color} hover:underline`}
      >
        <Icon className="h-3 w-3" />
        {t(c.labelKey)}
        <ArrowUpRight className="h-2.5 w-2.5" />
      </Link>
    );
  }

  return badge;
}

/* ------------------------------------------------------------------ */
/* Triggered-by badge                                                  */
/* ------------------------------------------------------------------ */

function TriggeredByBadge({ triggeredBy, t }: { triggeredBy: string; t: (key: string) => string }) {
  const map: Record<string, { label: string; color: string }> = {
    schedule:         { label: t("triggerSchedule"), color: "bg-blue-500/10 text-blue-400" },
    manual:           { label: t("triggerManual"), color: "bg-amber-500/10 text-amber-400" },
    startup_catchup:  { label: t("triggerCatchup"), color: "bg-purple-500/10 text-purple-400" },
  };
  const info = map[triggeredBy] || { label: triggeredBy, color: "bg-zinc-500/10 text-zinc-400" };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${info.color}`}>{info.label}</span>;
}

/* ------------------------------------------------------------------ */
/* Run history panel                                                   */
/* ------------------------------------------------------------------ */

function RunHistoryPanel({ automationId, t }: { automationId: string; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const { data: runs, isLoading } = useAutomationRuns(automationId);

  if (isLoading) {
    return <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" /></div>;
  }

  if (!runs || runs.length === 0) {
    return <p className="text-xs text-[var(--text-tertiary)] py-3 text-center">{t("noRuns")}</p>;
  }

  return (
    <div className="space-y-1.5 max-h-48 overflow-y-auto">
      {runs.map((run: TaskRunResponse) => (
        <div key={run.id} className="flex items-center gap-2 text-[11px] px-1 py-1.5 rounded hover:bg-[var(--surface-secondary)]/50">
          <StatusBadge status={run.status} sessionId={run.session_id} t={t} />
          <TriggeredByBadge triggeredBy={run.triggered_by} t={t} />
          <span className="text-[var(--text-tertiary)]">
            {formatDuration(run.started_at, run.finished_at)}
          </span>
          <span className="text-[var(--text-tertiary)] ml-auto">
            {relativeTime(run.started_at, t)}
          </span>
          {run.session_id && run.status !== "running" && (
            <Link href={`/c/${run.session_id}`} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Delete confirmation dialog                                          */
/* ------------------------------------------------------------------ */

function DeleteConfirmDialog({ name, onConfirm, onCancel, isPending, t }: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
  t: (key: string) => string;
}) {
  return (
    <DialogOverlay onClose={onCancel}>
      <div className="px-4 py-4">
        <p className="text-sm text-[var(--text-primary)]">{t("confirmDelete")}</p>
        <p className="text-xs text-[var(--text-tertiary)] mt-1">{name}</p>
      </div>
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border-default)]">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>{t("cancel")}</Button>
        <Button size="sm" className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white" onClick={onConfirm} disabled={isPending}>
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          {t("delete")}
        </Button>
      </div>
    </DialogOverlay>
  );
}

/* ------------------------------------------------------------------ */
/* Tab content (embedded in Settings)                                  */
/* ------------------------------------------------------------------ */

export function AutomationsTabContent() {
  const { t } = useTranslation("automations");
  const [tab, setTab] = useState<Tab>("active");
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex justify-end">
        <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setShowCreate(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t("createNew")}
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--border-default)]">
        {(["active", "all", "templates"] as Tab[]).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              tab === tabKey
                ? "border-[var(--text-primary)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {t(tabKey)}
          </button>
        ))}
      </div>

      {tab === "templates" ? <TemplatesTab onCreated={() => setTab("active")} /> : <AutomationsList filter={tab === "active" ? "enabled" : "all"} onEdit={setEditingId} />}

      {showCreate && <CreateAutomationDialog onClose={() => setShowCreate(false)} />}
      {editingId && <EditAutomationDialog automationId={editingId} onClose={() => setEditingId(null)} />}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Automation card                                                     */
/* ------------------------------------------------------------------ */

function AutomationCard({ automation: a, onEdit }: { automation: AutomationResponse; onEdit: (id: string) => void }) {
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

/* ------------------------------------------------------------------ */
/* Automations list                                                    */
/* ------------------------------------------------------------------ */

function AutomationsList({ filter, onEdit }: { filter: "enabled" | "all"; onEdit: (id: string) => void }) {
  const { t } = useTranslation("automations");
  const { data: automations, isLoading } = useAutomations();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  const items = (automations || []).filter((a) => filter === "all" || a.enabled);

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-[var(--text-tertiary)] text-sm">
        {t("noAutomations")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((a) => <AutomationCard key={a.id} automation={a} onEdit={onEdit} />)}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Templates tab                                                       */
/* ------------------------------------------------------------------ */

function TemplatesTab({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation("automations");
  const { data: templates, isLoading } = useTemplates();
  const createFromTemplate = useCreateFromTemplate();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {(templates || []).map((tpl) => {
        const IconComp = ICON_MAP[tpl.icon] || Timer;
        return (
          <button
            key={tpl.id}
            onClick={() => createFromTemplate.mutate(tpl.id, { onSuccess: onCreated })}
            disabled={createFromTemplate.isPending}
            className="text-left rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 hover:bg-[var(--surface-secondary)] transition-colors"
          >
            <div className="flex items-center gap-2 mb-2">
              <IconComp className="h-4 w-4 text-[var(--text-secondary)]" />
              <span className="text-sm font-medium text-[var(--text-primary)]">{tpl.name}</span>
            </div>
            <p className="text-xs text-[var(--text-tertiary)] line-clamp-2">{tpl.description}</p>
            <div className="flex items-center gap-1 mt-2 text-[10px] text-[var(--text-tertiary)]">
              {tpl.loop_max_iterations ? (
                <>
                  <Repeat className="h-3 w-3" />
                  <span>{t("loopIterations", { n: tpl.loop_max_iterations })}</span>
                </>
              ) : (
                <>
                  <Clock className="h-3 w-3" />
                  <span>{tpl.schedule_config ? humanizeSchedule(tpl.schedule_config as ScheduleConfig, t) : "—"}</span>
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Schedule config editor (shared between create & edit)               */
/* ------------------------------------------------------------------ */

/** Parse a cron string into { minute, hour, dow } for the visual editor. */
function parseCron(cron: string): { minute: number; hour: number; dow: number[] } {
  const parts = cron.split(" ");
  if (parts.length < 5) return { minute: 0, hour: 8, dow: [] };
  const [minStr, hourStr, , , dowStr] = parts;
  const minute = parseInt(minStr) || 0;
  const hour = parseInt(hourStr) || 0;
  let dow: number[] = [];
  if (dowStr === "*") {
    dow = [0, 1, 2, 3, 4, 5, 6];
  } else if (dowStr === "1-5") {
    dow = [1, 2, 3, 4, 5];
  } else if (dowStr === "0,6") {
    dow = [0, 6];
  } else {
    dow = dowStr.split(",").map((s) => parseInt(s)).filter((n) => !isNaN(n));
  }
  return { minute, hour, dow };
}

/** Build a cron string from visual editor state. */
function buildCron(hour: number, minute: number, dow: number[]): string {
  const sorted = [...dow].sort((a, b) => a - b);
  let dowStr: string;
  if (sorted.length === 0 || sorted.length === 7) {
    dowStr = "*";
  } else if (sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => sorted.includes(d))) {
    dowStr = "1-5";
  } else if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) {
    dowStr = "0,6";
  } else {
    dowStr = sorted.join(",");
  }
  return `${minute} ${hour} * * ${dowStr}`;
}

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun display order
const DAY_KEYS = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
// Map index: 0=sun, 1=mon, ..., 6=sat  →  key
function dayKey(d: number): string { return d === 0 ? "sun" : (DAY_KEYS[d] || ""); }

const selectClass = "h-8 rounded-md border border-[var(--border-default)] bg-transparent px-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)] appearance-none cursor-pointer";

function ScheduleEditor({ scheduleType, setScheduleType, cronExpr, setCronExpr, intervalHours, setIntervalHours, t }: {
  scheduleType: "cron" | "interval";
  setScheduleType: (v: "cron" | "interval") => void;
  cronExpr: string;
  setCronExpr: (v: string) => void;
  intervalHours: number;
  setIntervalHours: (v: number) => void;
  t: (key: string) => string;
}) {
  const parsed = parseCron(cronExpr);
  const [showRawCron, setShowRawCron] = useState(false);

  const updateCron = (hour: number, minute: number, dow: number[]) => {
    setCronExpr(buildCron(hour, minute, dow));
  };

  const toggleDay = (d: number) => {
    const next = parsed.dow.includes(d) ? parsed.dow.filter((x) => x !== d) : [...parsed.dow, d];
    updateCron(parsed.hour, parsed.minute, next);
  };

  // Day preset helpers
  const setDayPreset = (days: number[]) => updateCron(parsed.hour, parsed.minute, days);
  const isAllDays = parsed.dow.length === 7 || parsed.dow.length === 0;
  const isWeekdays = parsed.dow.length === 5 && [1, 2, 3, 4, 5].every((d) => parsed.dow.includes(d));
  const isWeekends = parsed.dow.length === 2 && parsed.dow.includes(0) && parsed.dow.includes(6);

  return (
    <div>
      <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("schedule")}</label>
      <div className="flex gap-2 mb-3">
        {(["cron", "interval"] as const).map((st) => (
          <button key={st} onClick={() => setScheduleType(st)}
            className={`px-3 py-1 text-xs rounded-md border transition-colors ${
              scheduleType === st
                ? "border-[var(--text-primary)] text-[var(--text-primary)] bg-[var(--surface-secondary)]"
                : "border-[var(--border-default)] text-[var(--text-tertiary)]"
            }`}
          >
            {st === "cron" ? t("triggerSchedule") : t("interval")}
          </button>
        ))}
      </div>
      {scheduleType === "cron" ? (
        <div className="space-y-3">
          {/* Time picker */}
          <div className="flex items-center gap-2">
            <select
              value={parsed.hour}
              onChange={(e) => updateCron(Number(e.target.value), parsed.minute, parsed.dow)}
              className={selectClass + " w-16 text-center"}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, "0")}</option>
              ))}
            </select>
            <span className="text-xs text-[var(--text-tertiary)]">:</span>
            <select
              value={parsed.minute}
              onChange={(e) => updateCron(parsed.hour, Number(e.target.value), parsed.dow)}
              className={selectClass + " w-16 text-center"}
            >
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
              ))}
            </select>
          </div>

          {/* Day-of-week presets */}
          <div className="flex gap-1.5">
            {([
              { label: t("days.everyday"), days: [0, 1, 2, 3, 4, 5, 6], active: isAllDays },
              { label: t("days.weekdays"), days: [1, 2, 3, 4, 5], active: isWeekdays },
              { label: t("days.weekends"), days: [0, 6], active: isWeekends },
            ] as const).map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setDayPreset([...p.days])}
                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  p.active
                    ? "border-[var(--text-primary)] text-[var(--text-primary)] bg-[var(--surface-secondary)]"
                    : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Day-of-week toggles */}
          <div className="flex gap-1">
            {ALL_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={`flex-1 py-1.5 text-[11px] rounded-md border transition-colors ${
                  parsed.dow.includes(d)
                    ? "border-[var(--text-primary)] text-[var(--text-primary)] bg-[var(--surface-secondary)]"
                    : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {t(`days.${dayKey(d)}`)}
              </button>
            ))}
          </div>

          {/* Summary + raw cron toggle */}
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-[var(--text-tertiary)]">
              {humanizeCron(cronExpr, t)}
            </p>
            <button
              type="button"
              onClick={() => setShowRawCron(!showRawCron)}
              className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
            >
              {showRawCron ? "—" : "cron"}
            </button>
          </div>

          {/* Raw cron (collapsed by default) */}
          {showRawCron && (
            <input type="text" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)}
              placeholder="0 8 * * 1" className={`${inputClass} font-mono`} />
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)]">{t("every")}</span>
          <input type="number" min={1} max={168} value={intervalHours}
            onChange={(e) => setIntervalHours(Number(e.target.value) || 1)}
            className="w-16 h-8 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs text-[var(--text-primary)] text-center focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
          />
          <span className="text-xs text-[var(--text-secondary)]">{t("hours")}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create automation dialog                                            */
/* ------------------------------------------------------------------ */

function CreateAutomationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("automations");
  const createMut = useCreateAutomation();
  const { data: models } = useModels();
  const selectedModel = useSettingsStore((s) => s.selectedModel);

  const globalWorkspace = useSettingsStore((s) => s.workspaceDirectory);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(selectedModel || "");
  const [workspace, setWorkspace] = useState(globalWorkspace || "");
  const [taskMode, setTaskMode] = useState<"scheduled" | "loop">("scheduled");
  const [scheduleType, setScheduleType] = useState<"cron" | "interval">("cron");
  const [cronExpr, setCronExpr] = useState("0 8 * * 1");
  const [intervalHours, setIntervalHours] = useState(1);
  const [loopIterations, setLoopIterations] = useState(10);

  const handleSubmit = () => {
    if (!name.trim() || !prompt.trim()) return;
    const data: AutomationCreate = {
      name: name.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      model: modelId || null,
      workspace: workspace.trim() || null,
    };
    if (taskMode === "loop") {
      data.loop_max_iterations = loopIterations;
      data.schedule_config = null;
    } else {
      data.schedule_config =
        scheduleType === "cron"
          ? { type: "cron", cron: cronExpr }
          : { type: "interval", hours: intervalHours };
    }
    createMut.mutate(data, { onSuccess: () => onClose() });
  };

  return (
    <DialogOverlay onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("createNew")}</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="px-4 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("name")}</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")} className={inputClass} />
        </div>

        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("description")}</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={t("descriptionPlaceholder")} className={inputClass} />
        </div>

        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("prompt")}</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("promptPlaceholder")} rows={4}
            className="w-full rounded-md border border-[var(--border-default)] bg-transparent px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)] resize-none"
          />
        </div>

        {/* Task mode: scheduled vs loop */}
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">{t("taskMode")}</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setTaskMode("scheduled")}
              className={`flex-1 h-8 rounded-md text-xs font-medium border transition-colors ${
                taskMode === "scheduled"
                  ? "border-[var(--border-focus)] bg-[var(--surface-secondary)] text-[var(--text-primary)]"
                  : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{t("scheduled")}</span>
            </button>
            <button type="button" onClick={() => setTaskMode("loop")}
              className={`flex-1 h-8 rounded-md text-xs font-medium border transition-colors ${
                taskMode === "loop"
                  ? "border-[var(--border-focus)] bg-[var(--surface-secondary)] text-[var(--text-primary)]"
                  : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" />{t("loopMode")}</span>
            </button>
          </div>
        </div>

        {taskMode === "scheduled" ? (
          <ScheduleEditor
            scheduleType={scheduleType} setScheduleType={setScheduleType}
            cronExpr={cronExpr} setCronExpr={setCronExpr}
            intervalHours={intervalHours} setIntervalHours={setIntervalHours}
            t={t}
          />
        ) : (
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("maxIterations")}</label>
            <div className="flex items-center gap-3">
              <input
                type="range" min={1} max={50} value={loopIterations}
                onChange={(e) => setLoopIterations(Number(e.target.value))}
                className="flex-1 h-1.5 accent-[var(--text-primary)]"
              />
              <span className="text-xs font-mono text-[var(--text-primary)] w-8 text-right">{loopIterations}</span>
            </div>
            <p className="text-[10px] text-[var(--text-tertiary)] mt-1">
              {t("loopHint")}
            </p>
          </div>
        )}

        {/* Model */}
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("model")}</label>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}
            className="w-full h-8 rounded-md border border-[var(--border-default)] bg-transparent px-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
          >
            <option value="">{t("modelAuto")}</option>
            {(models || []).filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.provider_id === "openai-subscription" ? " (Subscription)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Workspace */}
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("workspace")}</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder={t("workspaceNone")}
              className={inputClass + " flex-1"}
            />
            <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" onClick={async () => {
              const path = await browseDirectory(t("workspace"));
              if (path) setWorkspace(path);
            }}>
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
            {workspace && (
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2 shrink-0" onClick={() => setWorkspace("")}>
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border-default)]">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>{t("cancel")}</Button>
        <Button size="sm" className="h-7 text-xs" onClick={handleSubmit}
          disabled={!name.trim() || !prompt.trim() || createMut.isPending}
        >
          {createMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          {t("create")}
        </Button>
      </div>
    </DialogOverlay>
  );
}

/* ------------------------------------------------------------------ */
/* Edit automation dialog                                              */
/* ------------------------------------------------------------------ */

function EditAutomationDialog({ automationId, onClose }: { automationId: string; onClose: () => void }) {
  const { t } = useTranslation("automations");
  const { data: automations } = useAutomations();
  const updateMut = useUpdateAutomation();
  const { data: models } = useModels();
  const selectedModel = useSettingsStore((s) => s.selectedModel);

  const automation = automations?.find((a) => a.id === automationId);

  const [name, setName] = useState(automation?.name || "");
  const [description, setDescription] = useState(automation?.description || "");
  const [prompt, setPrompt] = useState(automation?.prompt || "");
  const [modelId, setModelId] = useState(automation?.model || selectedModel || "");
  const [workspace, setWorkspace] = useState(automation?.workspace || "");
  const isLoopTask = !!(automation?.loop_max_iterations);
  const [taskMode, setTaskMode] = useState<"scheduled" | "loop">(isLoopTask ? "loop" : "scheduled");
  const sc = automation?.schedule_config as ScheduleConfig | undefined;
  const [scheduleType, setScheduleType] = useState<"cron" | "interval">(sc?.type || "cron");
  const [cronExpr, setCronExpr] = useState(sc?.cron || "0 8 * * 1");
  const [intervalHours, setIntervalHours] = useState(sc?.hours || 1);
  const [loopIterations, setLoopIterations] = useState(automation?.loop_max_iterations || 10);

  if (!automation) return null;

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return;
    const data: AutomationUpdate = {
      name: name.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      model: modelId || null,
      workspace: workspace.trim() || null,
    };
    if (taskMode === "loop") {
      data.loop_max_iterations = loopIterations;
    } else {
      data.schedule_config =
        scheduleType === "cron"
          ? { type: "cron", cron: cronExpr }
          : { type: "interval", hours: intervalHours };
      data.loop_max_iterations = null;
    }
    updateMut.mutate({ id: automationId, data }, { onSuccess: () => onClose() });
  };

  return (
    <DialogOverlay onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("editAutomation")}</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="px-4 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("name")}</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("description")}</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={t("descriptionPlaceholder")} className={inputClass} />
        </div>

        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("prompt")}</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4}
            className="w-full rounded-md border border-[var(--border-default)] bg-transparent px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)] resize-none"
          />
        </div>

        {/* Task mode: scheduled vs loop */}
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">{t("taskMode")}</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setTaskMode("scheduled")}
              className={`flex-1 h-8 rounded-md text-xs font-medium border transition-colors ${
                taskMode === "scheduled"
                  ? "border-[var(--border-focus)] bg-[var(--surface-secondary)] text-[var(--text-primary)]"
                  : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{t("scheduled")}</span>
            </button>
            <button type="button" onClick={() => setTaskMode("loop")}
              className={`flex-1 h-8 rounded-md text-xs font-medium border transition-colors ${
                taskMode === "loop"
                  ? "border-[var(--border-focus)] bg-[var(--surface-secondary)] text-[var(--text-primary)]"
                  : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" />{t("loopMode")}</span>
            </button>
          </div>
        </div>

        {taskMode === "scheduled" ? (
          <ScheduleEditor
            scheduleType={scheduleType} setScheduleType={setScheduleType}
            cronExpr={cronExpr} setCronExpr={setCronExpr}
            intervalHours={intervalHours} setIntervalHours={setIntervalHours}
            t={t}
          />
        ) : (
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("maxIterations")}</label>
            <div className="flex items-center gap-3">
              <input
                type="range" min={1} max={50} value={loopIterations}
                onChange={(e) => setLoopIterations(Number(e.target.value))}
                className="flex-1 h-1.5 accent-[var(--text-primary)]"
              />
              <span className="text-xs font-mono text-[var(--text-primary)] w-8 text-right">{loopIterations}</span>
            </div>
            <p className="text-[10px] text-[var(--text-tertiary)] mt-1">{t("loopHint")}</p>
          </div>
        )}

        {/* Model */}
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("model")}</label>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}
            className="w-full h-8 rounded-md border border-[var(--border-default)] bg-transparent px-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
          >
            <option value="">{t("modelAuto")}</option>
            {(models || []).filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.provider_id === "openai-subscription" ? " (Subscription)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Workspace */}
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("workspace")}</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder={t("workspaceNone")}
              className={inputClass + " flex-1"}
            />
            <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" onClick={async () => {
              const path = await browseDirectory(t("workspace"));
              if (path) setWorkspace(path);
            }}>
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
            {workspace && (
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2 shrink-0" onClick={() => setWorkspace("")}>
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Run history inline */}
        {automation.run_count > 0 && (
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("history")}</label>
            <RunHistoryPanel automationId={automationId} t={t} />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border-default)]">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>{t("cancel")}</Button>
        <Button size="sm" className="h-7 text-xs" onClick={handleSave}
          disabled={!name.trim() || !prompt.trim() || updateMut.isPending}
        >
          {updateMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          {t("save")}
        </Button>
      </div>
    </DialogOverlay>
  );
}
