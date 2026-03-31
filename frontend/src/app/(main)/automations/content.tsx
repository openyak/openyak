"use client";

import { useState } from "react";
import {
  CalendarCheck,
  Clock,
  FolderSync,
  GitPullRequest,
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
  useTemplates,
  useCreateFromTemplate,
} from "@/hooks/use-automations";
import { humanizeSchedule } from "./helpers";
import { AutomationCard } from "./automation-card";
import { CreateAutomationDialog, EditAutomationDialog } from "./automation-dialogs";
import type { AutomationResponse, ScheduleConfig } from "@/types/automation";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

type Tab = "active" | "all" | "templates";

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
