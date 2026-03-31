"use client";

import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import { useSettingsStore } from "@/stores/settings-store";
import { SetupFlow } from "./ollama/ollama-setup";
import { StatusBar, NotRunningPanel } from "./ollama/ollama-status";
import { InstalledModelsList } from "./ollama/ollama-models";
import { ModelLibrary } from "./ollama/ollama-library";
import type { OllamaRuntimeStatus } from "./ollama/types";

export function OllamaPanel() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const { setActiveProvider } = useSettingsStore();

  const { data: runtimeStatus, refetch: refetchStatus } = useQuery({
    queryKey: ["ollamaRuntime"],
    queryFn: () => api.get<OllamaRuntimeStatus>(API.OLLAMA.STATUS),
    refetchInterval: 10_000,
  });

  const { data: installedModels, refetch: refetchModels } = useQuery({
    queryKey: ["ollamaInstalledModels"],
    queryFn: () => api.get<{ models: import("./ollama/types").OllamaModel[] }>(API.OLLAMA.MODELS),
    enabled: !!runtimeStatus?.running,
  });

  const { data: library } = useQuery({
    queryKey: ["ollamaLibrary"],
    queryFn: () => api.get<import("./ollama/types").LibraryData>(API.OLLAMA.LIBRARY),
  });

  if (!runtimeStatus) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
        <span className="text-xs text-[var(--text-secondary)]">Loading...</span>
      </div>
    );
  }

  const handleRemoved = () => {
    refetchStatus();
    qc.invalidateQueries({ queryKey: queryKeys.models });
    setActiveProvider(null);
  };

  if (!runtimeStatus.binary_installed) {
    return (
      <SetupFlow
        onComplete={() => {
          refetchStatus();
          setActiveProvider("ollama");
          qc.invalidateQueries({ queryKey: queryKeys.models });
        }}
      />
    );
  }

  if (!runtimeStatus.running) {
    return (
      <NotRunningPanel
        runtimeStatus={runtimeStatus}
        onStarted={() => {
          refetchStatus();
          refetchModels();
          setActiveProvider("ollama");
          qc.invalidateQueries({ queryKey: queryKeys.models });
        }}
        onRemoved={handleRemoved}
      />
    );
  }

  return (
    <div className="space-y-4">
      <StatusBar
        status={runtimeStatus}
        onStop={() => {
          refetchStatus();
          qc.invalidateQueries({ queryKey: queryKeys.models });
        }}
        onRemoved={handleRemoved}
      />

      <InstalledModelsList
        models={installedModels?.models ?? []}
        onDeleted={() => {
          refetchModels();
          qc.invalidateQueries({ queryKey: queryKeys.models });
        }}
      />

      {library && (
        <ModelLibrary
          library={library}
          installedNames={new Set((installedModels?.models ?? []).map((m) => m.name))}
          onPulled={() => {
            refetchModels();
            refetchStatus();
            qc.invalidateQueries({ queryKey: queryKeys.models });
          }}
        />
      )}
    </div>
  );
}
