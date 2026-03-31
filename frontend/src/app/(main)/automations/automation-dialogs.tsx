"use client";

import { useState } from "react";
import {
  Clock,
  FolderOpen,
  Loader2,
  Repeat,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  useAutomations,
  useCreateAutomation,
  useUpdateAutomation,
} from "@/hooks/use-automations";
import { useModels } from "@/hooks/use-models";
import { useSettingsStore } from "@/stores/settings-store";
import { browseDirectory } from "@/lib/upload";
import { DialogOverlay, ScheduleEditor, RunHistoryPanel, inputClass } from "./shared-ui";
import type {
  AutomationCreate,
  AutomationUpdate,
  ScheduleConfig,
} from "@/types/automation";

/* ------------------------------------------------------------------ */
/* Shared model selector                                               */
/* ------------------------------------------------------------------ */

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation("automations");
  const { data: models } = useModels();

  return (
    <div>
      <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("model")}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
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
  );
}

/* ------------------------------------------------------------------ */
/* Shared workspace picker                                             */
/* ------------------------------------------------------------------ */

function WorkspacePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation("automations");

  return (
    <div>
      <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("workspace")}</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("workspaceNone")}
          className={inputClass + " flex-1"}
        />
        <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" onClick={async () => {
          const path = await browseDirectory(t("workspace"));
          if (path) onChange(path);
        }}>
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
        {value && (
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2 shrink-0" onClick={() => onChange("")}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared task mode selector                                           */
/* ------------------------------------------------------------------ */

function TaskModeSelector({ value, onChange }: { value: "scheduled" | "loop"; onChange: (v: "scheduled" | "loop") => void }) {
  const { t } = useTranslation("automations");

  return (
    <div>
      <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">{t("taskMode")}</label>
      <div className="flex gap-2">
        <button type="button" onClick={() => onChange("scheduled")}
          className={`flex-1 h-8 rounded-md text-xs font-medium border transition-colors ${
            value === "scheduled"
              ? "border-[var(--border-focus)] bg-[var(--surface-secondary)] text-[var(--text-primary)]"
              : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{t("scheduled")}</span>
        </button>
        <button type="button" onClick={() => onChange("loop")}
          className={`flex-1 h-8 rounded-md text-xs font-medium border transition-colors ${
            value === "loop"
              ? "border-[var(--border-focus)] bg-[var(--surface-secondary)] text-[var(--text-primary)]"
              : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" />{t("loopMode")}</span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loop iterations slider                                              */
/* ------------------------------------------------------------------ */

function LoopIterationsSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { t } = useTranslation("automations");

  return (
    <div>
      <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("maxIterations")}</label>
      <div className="flex items-center gap-3">
        <input
          type="range" min={1} max={50} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 h-1.5 accent-[var(--text-primary)]"
        />
        <span className="text-xs font-mono text-[var(--text-primary)] w-8 text-right">{value}</span>
      </div>
      <p className="text-[10px] text-[var(--text-tertiary)] mt-1">{t("loopHint")}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create automation dialog                                            */
/* ------------------------------------------------------------------ */

export function CreateAutomationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("automations");
  const createMut = useCreateAutomation();
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("createNew")}</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

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

        <TaskModeSelector value={taskMode} onChange={setTaskMode} />

        {taskMode === "scheduled" ? (
          <ScheduleEditor
            scheduleType={scheduleType} setScheduleType={setScheduleType}
            cronExpr={cronExpr} setCronExpr={setCronExpr}
            intervalHours={intervalHours} setIntervalHours={setIntervalHours}
            t={t}
          />
        ) : (
          <LoopIterationsSlider value={loopIterations} onChange={setLoopIterations} />
        )}

        <ModelSelect value={modelId} onChange={setModelId} />
        <WorkspacePicker value={workspace} onChange={setWorkspace} />
      </div>

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

export function EditAutomationDialog({ automationId, onClose }: { automationId: string; onClose: () => void }) {
  const { t } = useTranslation("automations");
  const { data: automations } = useAutomations();
  const updateMut = useUpdateAutomation();
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("editAutomation")}</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

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

        <TaskModeSelector value={taskMode} onChange={setTaskMode} />

        {taskMode === "scheduled" ? (
          <ScheduleEditor
            scheduleType={scheduleType} setScheduleType={setScheduleType}
            cronExpr={cronExpr} setCronExpr={setCronExpr}
            intervalHours={intervalHours} setIntervalHours={setIntervalHours}
            t={t}
          />
        ) : (
          <LoopIterationsSlider value={loopIterations} onChange={setLoopIterations} />
        )}

        <ModelSelect value={modelId} onChange={setModelId} />
        <WorkspacePicker value={workspace} onChange={setWorkspace} />

        {automation.run_count > 0 && (
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">{t("history")}</label>
            <RunHistoryPanel automationId={automationId} t={t} />
          </div>
        )}
      </div>

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
