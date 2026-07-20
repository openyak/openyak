"use client";

import { useState } from "react";
import {
  CalendarCheck,
  Clock,
  FolderSync,
  GitPullRequest,
  Inbox,
  Loader2,
  Mail,
  Plus,
  Repeat,
  Sunrise,
  Timer,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  useAutomations,
  useRecentRuns,
  useTemplates,
  useCreateFromTemplate,
} from "@/hooks/use-automations";
import { humanizeSchedule } from "./helpers";
import { AutomationCard } from "./automation-card";
import { CreateAutomationDialog, EditAutomationDialog } from "./automation-dialogs";
import type { AutomationResponse, ScheduleConfig, RecentRun } from "@/types/automation";
import { getChatRoute } from "@/lib/routes";
import { useRouter } from "next/navigation";
import { formatRelativeTime } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

type Tab = "active" | "all" | "activity" | "templates";

const ICON_MAP: Record<string, React.ElementType> = {
  Sunrise, CalendarCheck, Mail, GitPullRequest, FolderSync, Timer, Clock, Repeat,
};

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
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-ui-2xs px-2.5"
          onClick={() => setShowCreate(true)}
        >
          <Plus className="h-3 w-3 mr-1" />
          {t("createNew")}
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--border-default)]">
        {(["active", "all", "activity", "templates"] as Tab[]).map((tabKey) => (
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

      {tab === "templates" ? (
        <TemplatesTab onCreated={() => setTab("active")} />
      ) : tab === "activity" ? (
        <ActivityFeed />
      ) : (
        <AutomationsList filter={tab === "active" ? "enabled" : "all"} onEdit={setEditingId} />
      )}

      {showCreate && <CreateAutomationDialog onClose={() => setShowCreate(false)} />}
      {editingId && <EditAutomationDialog automationId={editingId} onClose={() => setEditingId(null)} />}
    </div>
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

  const items = (automations || []).filter((a: AutomationResponse) => filter === "all" || a.enabled);

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-[var(--text-tertiary)] text-sm">
        {t("noAutomations")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((a: AutomationResponse) => <AutomationCard key={a.id} automation={a} onEdit={onEdit} />)}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Activity feed — recent runs across all automations                  */
/* ------------------------------------------------------------------ */

function runStatusColor(status: string): string {
  if (status === "success") return "var(--color-success)";
  if (status === "error") return "var(--color-destructive)";
  if (status === "running" || status === "pending") return "var(--tool-pending)";
  return "var(--text-tertiary)";
}

function ActivityFeed() {
  const { t } = useTranslation("automations");
  const router = useRouter();
  const { data: runs, isLoading } = useRecentRuns();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-[var(--text-tertiary)]">
        <Inbox className="h-6 w-6" />
        <p className="text-sm">{t("activityEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-default)]">
      {runs.map((run: RecentRun, index) => {
        const clickable = !!run.session_id;
        return (
          <button
            key={run.id}
            type="button"
            disabled={!clickable}
            onClick={() =>
              run.session_id && router.push(getChatRoute(run.session_id))
            }
            className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
              index > 0 ? "border-t border-[var(--border-default)]" : ""
            } ${clickable ? "hover:bg-[var(--surface-secondary)]" : "cursor-default"}`}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: runStatusColor(run.status) }}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-[var(--text-primary)]">
                {run.task_name}
              </p>
              <p className="truncate text-xs text-[var(--text-tertiary)]">
                {t(`runStatus_${run.status}`, { defaultValue: run.status })}
                {run.triggered_by === "manual" ? ` · ${t("triggerManual")}` : ""}
                {run.error_message ? ` · ${run.error_message}` : ""}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-[var(--text-tertiary)]">
              {formatRelativeTime(run.time_created)}
            </span>
          </button>
        );
      })}
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
            <div className="flex items-center gap-1 mt-2 text-ui-3xs text-[var(--text-tertiary)]">
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
