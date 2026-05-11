"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
  Play,
  Square,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, queryKeys } from "@/lib/constants";
import { LOCAL_MODEL_RECOMMENDATIONS } from "@/lib/local-models";
import { useSettingsStore } from "@/stores/settings-store";

interface RapidMLXRuntimeStatus {
  platform_supported: boolean;
  binary_installed: boolean;
  running: boolean;
  process_running: boolean;
  port: number;
  base_url: string | null;
  version: string | null;
  current_model: string;
  executable_path: string | null;
  install_commands: string[];
}

export function RapidMLXPanel() {
  const qc = useQueryClient();
  const { setActiveProvider } = useSettingsStore();
  const [modelInput, setModelInput] = useState("qwen3.5-4b");
  const [portInput, setPortInput] = useState("18080");

  const selectedModel = useMemo(
    () =>
      LOCAL_MODEL_RECOMMENDATIONS.find((model) =>
        model.variants.some((variant) => variant.rapidMlxAlias === modelInput),
      ) ?? LOCAL_MODEL_RECOMMENDATIONS[0],
    [modelInput],
  );
  const rapidVariants = useMemo(
    () =>
      selectedModel.variants.filter((variant) => !!variant.rapidMlxAlias),
    [selectedModel],
  );

  const {
    data: status,
    refetch,
    isError,
    error,
  } = useQuery({
    queryKey: ["rapidMlxRuntime"],
    queryFn: () => api.get<RapidMLXRuntimeStatus>(API.RAPID_MLX.STATUS),
    refetchInterval: 5_000,
    retry: false,
  });

  const startMutation = useMutation({
    mutationFn: () =>
      api.post<RapidMLXRuntimeStatus>(API.RAPID_MLX.START, {
        model: modelInput.trim() || "qwen3.5-4b",
        port: Number(portInput) || 18080,
      }),
    onSuccess: (next) => {
      refetch();
      qc.invalidateQueries({ queryKey: queryKeys.models });
      if (next.running) setActiveProvider("rapid-mlx");
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => api.post<RapidMLXRuntimeStatus>(API.RAPID_MLX.STOP, {}),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: queryKeys.models });
      setActiveProvider(null);
    },
  });

  if (isError) {
    return (
      <div className="space-y-3 py-2">
        <div className="flex items-center gap-2 text-xs text-[var(--color-destructive)]">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>
            {errorToMessage(error, "Failed to load Rapid-MLX status.")}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
        <span className="text-xs text-[var(--text-secondary)]">Loading...</span>
      </div>
    );
  }

  if (!status.platform_supported) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] p-3 text-xs text-[var(--text-secondary)]">
        Rapid-MLX is optimized for Apple Silicon macOS. Use Custom Endpoint on
        other platforms.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--text-secondary)]">
        Rapid-MLX runs local MLX models on Apple Silicon and exposes an
        OpenAI-compatible API at{" "}
        <span className="font-mono">http://localhost:18080/v1</span>.
      </p>

      {!status.binary_installed && (
        <div className="space-y-3 rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Terminal className="h-4 w-4" />
            <span>Install Rapid-MLX first, then come back and refresh.</span>
          </div>
          <div className="space-y-2">
            {status.install_commands.map((command) => (
              <code
                key={command}
                className="block rounded-md bg-[var(--surface-secondary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]"
              >
                {command}
              </code>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Refresh
            </Button>
            <a
              href="https://github.com/raullenchai/Rapid-MLX"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-[var(--brand-primary)] hover:underline"
            >
              GitHub <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}

      {status.binary_installed && (
        <div className="space-y-3">
          <div className="rounded-lg border border-[var(--border-default)] p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${status.running ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]"}`}
                />
                <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                  Rapid-MLX {status.version ?? ""}
                </span>
              </div>
              {status.base_url && (
                <span className="truncate rounded bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-ui-3xs text-[var(--text-tertiary)]">
                  {status.base_url}
                </span>
              )}
            </div>
          </div>

          {status.running ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setActiveProvider("rapid-mlx");
                  qc.invalidateQueries({ queryKey: queryKeys.models });
                }}
              >
                <Check className="mr-1.5 h-3.5 w-3.5" />
                Use Rapid-MLX
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => stopMutation.mutate()}
                disabled={stopMutation.isPending || !status.process_running}
                title={
                  status.process_running
                    ? "Stop Rapid-MLX"
                    : "This Rapid-MLX server was started outside OpenYak."
                }
              >
                {stopMutation.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Square className="mr-1.5 h-3.5 w-3.5" />
                )}
                Stop
              </Button>
            </div>
          ) : status.process_running ? (
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>
                Starting Rapid-MLX. First launch can take a while while the
                model downloads.
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-[var(--border-default)] p-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[1.2fr_1fr_88px_auto]">
                  <select
                    value={selectedModel.id}
                    onChange={(e) => {
                      const next = LOCAL_MODEL_RECOMMENDATIONS.find(
                        (model) => model.id === e.target.value,
                      );
                      const firstAlias = next?.variants.find(
                        (variant) => variant.rapidMlxAlias,
                      )?.rapidMlxAlias;
                      if (firstAlias) setModelInput(firstAlias);
                    }}
                    className="h-9 rounded-md border border-[var(--border-default)] bg-[var(--surface-primary)] px-2 text-xs text-[var(--text-primary)]"
                  >
                    {LOCAL_MODEL_RECOMMENDATIONS.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name} - {model.memory}
                      </option>
                    ))}
                  </select>
                  <select
                    value={
                      rapidVariants.find(
                        (variant) => variant.rapidMlxAlias === modelInput,
                      )?.rapidMlxAlias ?? ""
                    }
                    onChange={(e) => setModelInput(e.target.value)}
                    disabled={rapidVariants.length === 0}
                    className="h-9 rounded-md border border-[var(--border-default)] bg-[var(--surface-primary)] px-2 text-xs text-[var(--text-primary)]"
                  >
                    {rapidVariants.map((variant) => (
                      <option
                        key={`${selectedModel.id}-${variant.label}`}
                        value={variant.rapidMlxAlias}
                      >
                        {variant.label} ({variant.precision})
                      </option>
                    ))}
                  </select>
                  <Input
                    value={portInput}
                    onChange={(e) => setPortInput(e.target.value)}
                    placeholder="18080"
                    inputMode="numeric"
                    className="h-9 font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9"
                    onClick={() => startMutation.mutate()}
                    disabled={startMutation.isPending || rapidVariants.length === 0}
                  >
                    {startMutation.isPending ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Start
                  </Button>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[1fr_96px]">
                  <Input
                    value={modelInput}
                    onChange={(e) => setModelInput(e.target.value)}
                    placeholder="qwen3.5-4b"
                    className="h-8 font-mono text-xs"
                  />
                  <span className="flex h-8 items-center rounded-md bg-[var(--surface-secondary)] px-2 text-ui-3xs text-[var(--text-tertiary)]">
                    manual alias
                  </span>
                </div>
                <p className="mt-2 text-ui-3xs text-[var(--text-tertiary)]">
                  Start is always available here; first launch may download the
                  selected model.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-[var(--text-primary)]">
                    Recommended local models
                  </h3>
                  <span className="text-ui-3xs text-[var(--text-tertiary)]">
                    MLX variants only
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {LOCAL_MODEL_RECOMMENDATIONS.map((model) => {
                    const aliases = model.variants
                      .filter((variant) => variant.rapidMlxAlias)
                      .map((variant) => variant.label);
                    const selected = model.id === selectedModel.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => {
                          const firstAlias = model.variants.find(
                            (variant) => variant.rapidMlxAlias,
                          )?.rapidMlxAlias;
                          if (firstAlias) setModelInput(firstAlias);
                        }}
                        className={`flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                          selected
                            ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                            : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                            {model.name}
                          </div>
                          <div className="truncate text-ui-3xs text-[var(--text-tertiary)]">
                            {aliases.length} MLX option{aliases.length === 1 ? "" : "s"}
                          </div>
                        </div>
                        <span className="shrink-0 rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-ui-3xs text-[var(--text-tertiary)]">
                          {model.memory}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {startMutation.isError && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {errorToMessage(
                  startMutation.error,
                  "Failed to start Rapid-MLX",
                )}
              </span>
            </div>
          )}
          {stopMutation.isError && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {errorToMessage(stopMutation.error, "Failed to stop Rapid-MLX")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
