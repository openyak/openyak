"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clock,
  Loader2,
  Repeat,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAutomationRuns } from "@/hooks/use-automations";
import { humanizeCron, humanizeSchedule, relativeTime, formatDuration, parseCron, buildCron } from "./helpers";
import type { ScheduleConfig, TaskRunResponse } from "@/types/automation";

/* ------------------------------------------------------------------ */
/* Shared styles                                                       */
/* ------------------------------------------------------------------ */

export const inputClass = "w-full h-8 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]";

const selectClass = "h-8 rounded-md border border-[var(--border-default)] bg-transparent px-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)] appearance-none cursor-pointer";

/* ------------------------------------------------------------------ */
/* Dialog overlay                                                      */
/* ------------------------------------------------------------------ */

export function DialogOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
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

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export function StatusBadge({ status, sessionId, t }: { status: string | null; sessionId: string | null; t: TFunc }) {
  if (!status) return null;

  const config: Record<string, { icon: React.ElementType; color: string; labelKey: string }> = {
    running: { icon: Loader2, color: "text-amber-400", labelKey: "statusRunning" },
    success: { icon: Check, color: "text-emerald-400", labelKey: "statusSuccess" },
    error:   { icon: XCircle, color: "text-red-400", labelKey: "statusError" },
    timeout: { icon: XCircle, color: "text-orange-400", labelKey: "statusTimeout" },
  };

  const normalizedStatus = status.startsWith("running") ? "running" : status;
  const c = config[normalizedStatus];
  if (!c) return null;
  const Icon = c.icon;
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

export function TriggeredByBadge({ triggeredBy, t }: { triggeredBy: string; t: (key: string) => string }) {
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

export function RunHistoryPanel({ automationId, t }: { automationId: string; t: TFunc }) {
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

export function DeleteConfirmDialog({ name, onConfirm, onCancel, isPending, t }: {
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
/* Schedule config editor (shared between create & edit)               */
/* ------------------------------------------------------------------ */

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun display order
const DAY_KEYS = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
function dayKey(d: number): string { return d === 0 ? "sun" : (DAY_KEYS[d] || ""); }

export function ScheduleEditor({ scheduleType, setScheduleType, cronExpr, setCronExpr, intervalHours, setIntervalHours, t }: {
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
