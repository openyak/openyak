"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
  Play,
  PowerOff,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, queryKeys } from "@/lib/constants";
import {
  canonicalRapidMlxModel,
  LOCAL_MODEL_RECOMMENDATIONS,
} from "@/lib/local-models";
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
  const [removingAlias, setRemovingAlias] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{
    alias: string;
    name: string;
  } | null>(null);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstallResult, setUninstallResult] = useState<{
    stopped: boolean;
    removed_models: string[];
    freed_bytes: number;
    binary_install_commands: string[];
  } | null>(null);
  const rapidAliases = useMemo(
    () =>
      Array.from(
        new Set(
          LOCAL_MODEL_RECOMMENDATIONS.flatMap((model) =>
            model.variants
              .map((variant) => variant.rapidMlxAlias)
              .filter((alias): alias is string => !!alias),
          ),
        ),
      ),
    [],
  );

  const selectedModel = useMemo(
    () =>
      LOCAL_MODEL_RECOMMENDATIONS.find((model) =>
        model.variants.some(
          (variant) =>
            canonicalRapidMlxModel(variant.rapidMlxAlias) ===
            canonicalRapidMlxModel(modelInput),
        ),
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
  const { data: cachedModels } = useQuery({
    queryKey: ["rapidMlxCached", rapidAliases],
    queryFn: () =>
      api.post<{ cached: Record<string, boolean> }>(API.RAPID_MLX.CACHED, {
        aliases: rapidAliases,
      }),
    enabled: !!status?.binary_installed,
    refetchInterval: 10_000,
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

  const removeMutation = useMutation({
    mutationFn: async (alias: string) => {
      setRemovingAlias(alias);
      return api.post<{ cached: Record<string, boolean> }>(
        API.RAPID_MLX.REMOVE,
        { alias },
      );
    },
    onSuccess: () => {
      setRemovingAlias(null);
      setPendingRemoval(null);
      qc.invalidateQueries({ queryKey: ["rapidMlxCached"] });
    },
    onError: () => setRemovingAlias(null),
  });

  const uninstallMutation = useMutation({
    mutationFn: () =>
      api.delete<{
        stopped: boolean;
        removed_models: string[];
        freed_bytes: number;
        binary_install_commands: string[];
      }>(API.RAPID_MLX.UNINSTALL(true)),
    onSuccess: (res) => {
      setUninstallResult(res);
      refetch();
      qc.invalidateQueries({ queryKey: ["rapidMlxCached"] });
      qc.invalidateQueries({ queryKey: queryKeys.models });
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      setActiveProvider(null);
    },
  });

  const isAliasCached = (alias: string | undefined) =>
    !!alias && !!cachedModels?.cached?.[alias];
  const selectedAliasCached = isAliasCached(modelInput);
  const isStarting = status?.process_running && !status.running;
  const selectedPort = Number(portInput) || 18080;
  const isRunningModelAlias = (alias: string | undefined) =>
    !!alias &&
    !!status?.running &&
    canonicalRapidMlxModel(status.current_model) ===
      canonicalRapidMlxModel(alias);
  // Active = running OR mid-startup. Removing a model while it's loading
  // would race with the spawning process — backend rejects it anyway, but
  // gating in the UI avoids a confusing error toast.
  const isActiveModelAlias = (alias: string | undefined) =>
    !!alias &&
    (!!status?.running || !!status?.process_running) &&
    canonicalRapidMlxModel(status?.current_model ?? "") ===
      canonicalRapidMlxModel(alias);
  const selectedModelIsRunning =
    isRunningModelAlias(modelInput) && status?.port === selectedPort;
  const selectedModelIsActive =
    isActiveModelAlias(modelInput) && status?.port === selectedPort;
  const primaryActionLabel = selectedModelIsRunning
    ? "Running"
    : status?.running
      ? "Switch"
      : "Start";
  const primaryActionDisabled =
    startMutation.isPending ||
    uninstallMutation.isPending ||
    selectedModelIsRunning ||
    !!isStarting ||
    rapidVariants.length === 0 ||
    !modelInput.trim();
  // Stop is only relevant when there's something to stop. Showing it
  // disabled in the idle state used to look like broken functionality;
  // hide it instead so the action surface reflects reality.
  const stopVisible =
    !!status?.running || !!status?.process_running || stopMutation.isPending;
  const stopDisabled = stopMutation.isPending;
  // Top-row Remove only acts on the currently-selected alias. When that
  // alias isn't cached the button has nothing to do — hide it and let
  // the user use the per-row trash icon for whichever model they want
  // to delete. (Also gated by the running-model rule.)
  const removeVisible = selectedAliasCached;

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
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    status.running
                      ? "bg-[var(--color-success)]"
                      : status.process_running
                        ? "bg-[var(--color-warning)]"
                        : "bg-[var(--text-tertiary)]"
                  }`}
                />
                <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                  Rapid-MLX {status.version ?? ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {status.base_url && (
                  <span className="truncate rounded bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-ui-3xs text-[var(--text-tertiary)]">
                    {status.base_url}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-ui-3xs text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
                  onClick={() => {
                    setUninstallResult(null);
                    setUninstallOpen(true);
                  }}
                  disabled={
                    stopMutation.isPending ||
                    startMutation.isPending ||
                    removeMutation.isPending ||
                    uninstallMutation.isPending
                  }
                  title={
                    stopMutation.isPending
                      ? "Wait for the current stop to finish"
                      : startMutation.isPending
                        ? "Wait for the current start to finish"
                        : removeMutation.isPending
                          ? "Wait for the model removal to finish"
                          : "Uninstall Rapid-MLX from OpenYak"
                  }
                >
                  <PowerOff className="mr-1 h-3 w-3" />
                  Uninstall
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border-default)] p-3">
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_96px]">
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
                    (variant) =>
                      canonicalRapidMlxModel(variant.rapidMlxAlias) ===
                      canonicalRapidMlxModel(modelInput),
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
                    {variant.label} ({variant.precision}) -{" "}
                    {isAliasCached(variant.rapidMlxAlias)
                      ? "installed"
                      : "not installed"}
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
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_96px]">
                <Input
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder="qwen3.5-4b"
                  className="h-9 font-mono text-xs"
                />
                <span className="flex h-9 items-center rounded-md bg-[var(--surface-secondary)] px-2 text-ui-3xs text-[var(--text-tertiary)]">
                  manual alias
                </span>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 min-w-24"
                  onClick={() => startMutation.mutate()}
                  disabled={primaryActionDisabled}
                >
                  {startMutation.isPending || isStarting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : selectedModelIsRunning ? (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {isStarting ? "Starting" : primaryActionLabel}
                </Button>
                {stopVisible && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 min-w-20"
                    onClick={() => stopMutation.mutate()}
                    disabled={stopDisabled}
                    title="Stop Rapid-MLX"
                  >
                    {stopMutation.isPending ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Square className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Stop
                  </Button>
                )}
                {removeVisible && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 min-w-24"
                    onClick={() =>
                      setPendingRemoval({
                        alias: modelInput,
                        name: selectedModel.name,
                      })
                    }
                    disabled={
                      removeMutation.isPending ||
                      uninstallMutation.isPending ||
                      selectedModelIsActive
                    }
                    title={
                      selectedModelIsActive
                        ? "Stop Rapid-MLX before removing the running model"
                        : "Remove downloaded Rapid-MLX model"
                    }
                  >
                    {removingAlias === modelInput ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Remove
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-2 text-ui-3xs text-[var(--text-tertiary)]">
              {isStarting
                ? "Rapid-MLX is starting. Stop is available if you need to cancel."
                : selectedModelIsRunning
                  ? "Selected model is running."
                  : status.running
                  ? "Switch restarts Rapid-MLX on the selected model."
                  : selectedAliasCached
                    ? "Selected model is already downloaded."
                    : "Selected model is not downloaded yet; first launch will download it."}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-[var(--text-primary)]">
                Recommended local models
              </h3>
              <span className="text-ui-3xs text-[var(--text-tertiary)]">
                Download status
              </span>
            </div>
            <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
              {LOCAL_MODEL_RECOMMENDATIONS.map((model) => {
                const variants = model.variants.filter(
                  (variant) => variant.rapidMlxAlias,
                );
                const installedVariants = variants.filter((variant) =>
                  isAliasCached(variant.rapidMlxAlias),
                );
                const installedCount = installedVariants.length;
                const removableAlias =
                  installedVariants.length === 1
                    ? installedVariants[0].rapidMlxAlias
                    : undefined;
                const removableAliasIsActive =
                  isActiveModelAlias(removableAlias);
                const selected = model.id === selectedModel.id;
                return (
                  <div
                    key={model.id}
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
                    } cursor-pointer`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                        {model.name}
                      </div>
                      <div className="truncate text-ui-3xs text-[var(--text-tertiary)]">
                        {installedCount}/{variants.length} installed
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-ui-3xs ${
                          installedCount > 0
                            ? "bg-[var(--color-success)]/10 text-[var(--color-success)]"
                            : "bg-[var(--surface-secondary)] text-[var(--text-tertiary)]"
                        }`}
                      >
                        {installedCount > 0 ? "Installed" : "Not installed"}
                      </span>
                      {removableAlias && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingRemoval({
                              alias: removableAlias,
                              name: model.name,
                            });
                          }}
                          disabled={
                            removeMutation.isPending ||
                            uninstallMutation.isPending ||
                            removableAliasIsActive
                          }
                          className="rounded p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--color-destructive)] disabled:opacity-60"
                          title={
                            removableAliasIsActive
                              ? "Stop Rapid-MLX before removing the running model"
                              : `Remove ${removableAlias}`
                          }
                        >
                          {removingAlias === removableAlias ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

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
          {removeMutation.isError && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {errorToMessage(
                  removeMutation.error,
                  "Failed to remove Rapid-MLX model",
                )}
              </span>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={!!pendingRemoval}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) setPendingRemoval(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove local model?</DialogTitle>
            <DialogDescription>
              This deletes the downloaded Rapid-MLX model from the HuggingFace
              cache. You can download it again by starting the model later.
            </DialogDescription>
          </DialogHeader>
          {pendingRemoval && (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2">
                <div className="text-xs font-medium text-[var(--text-primary)]">
                  {pendingRemoval.name}
                </div>
                <div className="mt-1 truncate font-mono text-ui-3xs text-[var(--text-tertiary)]">
                  {pendingRemoval.alias}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRemoval(null)}
                  disabled={removeMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => removeMutation.mutate(pendingRemoval.alias)}
                  disabled={removeMutation.isPending}
                >
                  {removingAlias === pendingRemoval.alias ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Remove
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={uninstallOpen}
        onOpenChange={(open) => {
          if (!open && !uninstallMutation.isPending) {
            setUninstallOpen(false);
            setUninstallResult(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Uninstall Rapid-MLX from OpenYak?</DialogTitle>
            <DialogDescription>
              This stops the Rapid-MLX runtime, deletes every downloaded MLX
              model from the HuggingFace cache, and clears OpenYak&apos;s
              Rapid-MLX settings.
            </DialogDescription>
          </DialogHeader>

          {!uninstallResult && (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                <div className="font-medium text-[var(--text-primary)]">
                  What this does
                </div>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-ui-3xs">
                  <li>Stops the running Rapid-MLX process (if any)</li>
                  <li>Deletes all downloaded MLX model snapshots</li>
                  <li>Clears the saved base URL and last-used model</li>
                  <li>Unregisters Rapid-MLX as an active provider</li>
                </ul>
              </div>
              <div className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2">
                <div className="text-xs font-medium text-[var(--text-primary)]">
                  Remove the binary itself
                </div>
                <p className="mt-0.5 text-ui-3xs text-[var(--text-tertiary)]">
                  OpenYak can&apos;t uninstall a brew/pip-managed binary for
                  you. Run one of these after this dialog if you want a full
                  removal:
                </p>
                <div className="mt-2 space-y-1">
                  <code className="block rounded bg-[var(--surface-primary)] px-2 py-1 font-mono text-ui-3xs">
                    brew uninstall raullenchai/rapid-mlx/rapid-mlx
                  </code>
                  <code className="block rounded bg-[var(--surface-primary)] px-2 py-1 font-mono text-ui-3xs">
                    pip uninstall rapid-mlx
                  </code>
                </div>
              </div>
              {uninstallMutation.isError && (
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {errorToMessage(
                      uninstallMutation.error,
                      "Failed to uninstall Rapid-MLX",
                    )}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUninstallOpen(false)}
                  disabled={uninstallMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => uninstallMutation.mutate()}
                  disabled={uninstallMutation.isPending}
                >
                  {uninstallMutation.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PowerOff className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Uninstall
                </Button>
              </div>
            </div>
          )}

          {uninstallResult && (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-xs">
                <div className="font-medium text-[var(--text-primary)]">
                  Rapid-MLX cleaned up
                </div>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-ui-3xs text-[var(--text-secondary)]">
                  <li>
                    Runtime stopped: {uninstallResult.stopped ? "yes" : "was not running"}
                  </li>
                  <li>
                    Removed {uninstallResult.removed_models.length} model
                    {uninstallResult.removed_models.length === 1 ? "" : "s"}
                    {uninstallResult.freed_bytes > 0
                      ? ` (${(uninstallResult.freed_bytes / 1_073_741_824).toFixed(2)} GB freed)`
                      : ""}
                  </li>
                  <li>OpenYak settings cleared</li>
                </ul>
              </div>
              <div className="rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2">
                <div className="text-xs font-medium text-[var(--text-primary)]">
                  To remove the binary, run one of:
                </div>
                <div className="mt-2 space-y-1">
                  {uninstallResult.binary_install_commands.map((cmd) => (
                    <code
                      key={cmd}
                      className="block rounded bg-[var(--surface-primary)] px-2 py-1 font-mono text-ui-3xs"
                    >
                      {cmd}
                    </code>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-end">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    setUninstallOpen(false);
                    setUninstallResult(null);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
