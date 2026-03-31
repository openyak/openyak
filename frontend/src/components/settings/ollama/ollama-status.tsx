"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import {
  Loader2,
  AlertCircle,
  Trash2,
  HardDrive,
  Play,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { API } from "@/lib/constants";
import { formatBytes, type OllamaRuntimeStatus } from "./types";

/* ------------------------------------------------------------------ */
/* Remove Confirmation                                                 */
/* ------------------------------------------------------------------ */

export function RemoveConfirmation({
  diskUsage,
  deleteModels,
  setDeleteModels,
  isPending,
  onConfirm,
  onCancel,
}: {
  diskUsage: number;
  deleteModels: boolean;
  setDeleteModels: (v: boolean) => void;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-3 space-y-3">
      <p className="text-xs text-[var(--text-secondary)]">
        {t("ollamaRemoveConfirm", "Are you sure you want to remove Ollama? This will stop the server and delete the binary.")}
      </p>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={deleteModels}
          onChange={(e) => setDeleteModels(e.target.checked)}
          className="rounded border-[var(--border-default)]"
        />
        <span className="text-xs text-[var(--text-secondary)]">
          {t("ollamaDeleteModels", "Also delete all downloaded models")}
          {diskUsage > 0 && (
            <span className="text-[var(--text-tertiary)]"> ({formatBytes(diskUsage)})</span>
          )}
        </span>
      </label>
      <div className="flex items-center gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          )}
          {t("ollamaRemoveBtn", "Remove Ollama")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          {t("cancel", "Cancel")}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Not Running Panel                                                   */
/* ------------------------------------------------------------------ */

export function NotRunningPanel({
  runtimeStatus,
  onStarted,
  onRemoved,
}: {
  runtimeStatus: OllamaRuntimeStatus;
  onStarted: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("settings");
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [deleteModels, setDeleteModels] = useState(true);

  const startMutation = useMutation({
    mutationFn: () => api.post(API.OLLAMA.START, {}),
    onSuccess: () => onStarted(),
  });

  const removeMutation = useMutation({
    mutationFn: () =>
      api.delete(API.OLLAMA.UNINSTALL(deleteModels)),
    onSuccess: () => {
      setShowRemoveConfirm(false);
      onRemoved();
    },
  });

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-3">
        <div className="flex items-center gap-2 text-xs">
          <Square className="h-3.5 w-3.5 text-[var(--color-warning)]" />
          <span className="text-[var(--text-secondary)]">
            {t("ollamaStopped", "Ollama is installed but not running")}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending}
        >
          {startMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Play className="h-3.5 w-3.5 mr-1.5" />
          )}
          {t("ollamaStart", "Start Ollama")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)]"
          onClick={() => setShowRemoveConfirm(true)}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          {t("ollamaRemove", "Remove")}
        </Button>
      </div>
      {startMutation.isError && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {startMutation.error instanceof ApiError
              ? ((startMutation.error.body as Record<string, string>)?.detail ?? "Failed to start")
              : "Failed to start Ollama"}
          </span>
        </div>
      )}

      {showRemoveConfirm && (
        <RemoveConfirmation
          diskUsage={runtimeStatus.disk_usage_bytes}
          deleteModels={deleteModels}
          setDeleteModels={setDeleteModels}
          isPending={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate()}
          onCancel={() => setShowRemoveConfirm(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status Bar                                                          */
/* ------------------------------------------------------------------ */

export function StatusBar({
  status,
  onStop,
  onRemoved,
}: {
  status: OllamaRuntimeStatus;
  onStop: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("settings");
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [deleteModels, setDeleteModels] = useState(true);

  const stopMutation = useMutation({
    mutationFn: () => api.post(API.OLLAMA.STOP, {}),
    onSuccess: () => onStop(),
  });

  const removeMutation = useMutation({
    mutationFn: () =>
      api.delete(API.OLLAMA.UNINSTALL(deleteModels)),
    onSuccess: () => {
      setShowRemoveConfirm(false);
      onRemoved();
    },
  });

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-[var(--border-default)] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--color-success)]" />
            <span className="text-xs font-medium text-[var(--text-primary)]">
              Ollama {status.version && `v${status.version}`}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-[var(--text-tertiary)]">
            <span className="flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {formatBytes(status.disk_usage_bytes)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
              title={t("ollamaStop", "Stop Ollama")}
            >
              {stopMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Square className="h-3 w-3" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--color-destructive)]"
              onClick={() => setShowRemoveConfirm(true)}
              title={t("ollamaRemove", "Remove Ollama")}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {showRemoveConfirm && (
        <RemoveConfirmation
          diskUsage={status.disk_usage_bytes}
          deleteModels={deleteModels}
          setDeleteModels={setDeleteModels}
          isPending={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate()}
          onCancel={() => setShowRemoveConfirm(false)}
        />
      )}
    </div>
  );
}
