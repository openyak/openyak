"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, X, Check, Loader2, AlertCircle, LogOut, RotateCw, Cpu, Server, Plug } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsStore } from "@/stores/settings-store";
import { api, ApiError } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, IS_DESKTOP, queryKeys } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";
import { useModels } from "@/hooks/use-models";
import type { ApiKeyStatus, ProviderInfo, LocalProviderStatus } from "@/types/usage";
import type { ModelInfo } from "@/types/model";
import { OllamaPanel } from "@/components/settings/ollama-panel";

/** Backwards-compatible alias for callers that still expect ApiError-only narrowing. */
function extractApiDetail(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  return errorToMessage(err, fallback);
}

interface OpenAISubscriptionStatus {
  is_connected: boolean;
  email: string;
  needs_reauth?: boolean;
}

export function ProvidersTab() {
  const { t } = useTranslation('settings');
  const { activeProvider, setActiveProvider } = useSettingsStore();

  type ProviderMode = "byok" | "chatgpt" | "ollama" | "local" | "custom";
  const [viewingProvider, setViewingProvider] = useState<ProviderMode>(
    () => (activeProvider as ProviderMode) ?? "chatgpt"
  );

  const [mounted, setMounted] = useState(false);
  const qc = useQueryClient();
  const { data: allModels } = useModels();

  const [localBaseUrlInput, setLocalBaseUrlInput] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const { data: keyStatus } = useQuery({ queryKey: queryKeys.apiKeyStatus, queryFn: () => api.get<ApiKeyStatus>(API.CONFIG.API_KEY) });

  // Multi-provider BYOK status
  const { data: providers } = useQuery({
    queryKey: queryKeys.providers,
    queryFn: () => api.get<ProviderInfo[]>(API.CONFIG.PROVIDERS),
  });

  const { data: localStatus } = useQuery({
    queryKey: queryKeys.localProvider,
    queryFn: () => api.get<LocalProviderStatus>(API.CONFIG.LOCAL_PROVIDER),
  });

  useEffect(() => {
    setLocalBaseUrlInput(localStatus?.base_url ?? "");
  }, [localStatus?.base_url]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fallbackToOtherProviders = () => {
    if (openaiSubStatus?.is_connected) {
      setActiveProvider("chatgpt");
    } else if (keyStatus?.is_configured || (providers ?? []).some((p) => p.is_configured)) {
      setActiveProvider("byok");
    } else {
      setActiveProvider(null);
    }
  };

  const pickModelForMode = (mode: ProviderMode, models: ModelInfo[] | undefined) => {
    if (!models || models.length === 0) return null;
    if (mode === "byok") {
      return models.find((m) => !["openai-subscription", "ollama"].includes(m.provider_id)) ?? null;
    }
    if (mode === "chatgpt") {
      return models.find((m) => m.provider_id === "openai-subscription") ?? null;
    }
    if (mode === "ollama") {
      return models.find((m) => m.provider_id === "ollama") ?? null;
    }
    if (mode === "local") {
      return models.find((m) => m.provider_id === "local") ?? null;
    }
    if (mode === "custom") {
      return models.find((m) => m.provider_id?.startsWith("custom_")) ?? null;
    }
    return null;
  };

  const activateProviderMode = (mode: ProviderMode) => {
    setActiveProvider(mode);
    const picked = pickModelForMode(mode, allModels);
    if (picked) {
      useSettingsStore.getState().setSelectedModel(picked.id, picked.provider_id);
    }
  };

  const { data: openaiSubStatus, refetch: refetchOpenaiSub } = useQuery({
    queryKey: queryKeys.openaiSubscription,
    queryFn: () => api.get<OpenAISubscriptionStatus>(API.CONFIG.OPENAI_SUBSCRIPTION),
  });

  // Per-provider key input state and mutations
  const [providerKeyInputs, setProviderKeyInputs] = useState<Record<string, string>>({});
  const [providerBaseUrlInputs, setProviderBaseUrlInputs] = useState<Record<string, string>>({});
  const [showProviderKey, setShowProviderKey] = useState<Record<string, boolean>>({});
  const [providerMutatingId, setProviderMutatingId] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<Record<string, string>>({});
  const [customEndpointName, setCustomEndpointName] = useState<string>("");

  const updateProviderKey = useMutation({
    mutationFn: async ({ id, apiKey, baseUrl }: { id: string; apiKey: string; baseUrl?: string }) => {
      setProviderMutatingId(id);
      return api.post<ProviderInfo>(API.CONFIG.PROVIDER_KEY(id), { api_key: apiKey, base_url: baseUrl });
    },
    onSuccess: (_data, { id }) => {
      setProviderKeyInputs((prev) => ({ ...prev, [id]: "" }));
      setProviderError((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setProviderMutatingId(null);
      activateProviderMode("byok");
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err, { id }) => {
      setProviderMutatingId(null);
      const detail = errorToMessage(err, t('failedSaveKey'));
      setProviderError((prev) => ({ ...prev, [id]: detail }));
    },
  });

  const deleteProviderKey = useMutation({
    mutationFn: async (id: string) => {
      setProviderMutatingId(id);
      return api.delete<ProviderInfo>(API.CONFIG.PROVIDER_KEY(id));
    },
    onSuccess: () => {
      setProviderMutatingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: () => { setProviderMutatingId(null); },
  });

  const toggleProvider = useMutation({
    mutationFn: (id: string) => api.post<ProviderInfo>(API.CONFIG.PROVIDER_TOGGLE(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
  });

  const createCustomEndpoint = useMutation({
    mutationFn: async ({ name, apiKey, baseUrl }: { name: string; apiKey?: string; baseUrl: string }) => {
      setProviderMutatingId("custom_new");
      return api.post<ProviderInfo>(API.CONFIG.CUSTOM_ENDPOINT, { name, api_key: apiKey || "", base_url: baseUrl });
    },
    onSuccess: () => {
      setProviderKeyInputs((prev) => ({ ...prev, ["custom_new"]: "" }));
      setProviderBaseUrlInputs((prev) => ({ ...prev, ["custom_new"]: "" }));
      setCustomEndpointName("");
      setProviderError((prev) => { const next = { ...prev }; delete next["custom_new"]; return next; });
      setProviderMutatingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err) => {
      setProviderMutatingId(null);
      setProviderError((prev) => ({ ...prev, ["custom_new"]: extractApiDetail(err, "Failed to save endpoint") }));
    },
  });

  const deleteCustomEndpoint = useMutation({
    mutationFn: async (id: string) => {
      setProviderMutatingId(id);
      return api.delete<ProviderInfo>(API.CONFIG.CUSTOM_ENDPOINT_ITEM(id));
    },
    onSuccess: () => {
      setProviderMutatingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: () => { setProviderMutatingId(null); },
  });

  const updateCustomEndpoint = useMutation({
    mutationFn: async ({ id, name, apiKey, baseUrl, enabled }: { id: string; name?: string; apiKey?: string; baseUrl?: string; enabled?: boolean }) => {
      setProviderMutatingId(id);
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (apiKey !== undefined) body.api_key = apiKey;
      if (baseUrl !== undefined) body.base_url = baseUrl;
      if (enabled !== undefined) body.enabled = enabled;
      return api.patch<ProviderInfo>(API.CONFIG.CUSTOM_ENDPOINT_ITEM(id), body);
    },
    onSuccess: () => {
      setProviderMutatingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err, { id }) => {
      setProviderMutatingId(null);
      setProviderError((prev) => ({ ...prev, [id]: extractApiDetail(err, "Failed to update endpoint") }));
    },
  });

  const updateLocalProvider = useMutation({
    mutationFn: async (base_url: string) =>
      api.post<LocalProviderStatus>(API.CONFIG.LOCAL_PROVIDER, { base_url }),
    onSuccess: () => {
      setLocalError(null);
      qc.invalidateQueries({ queryKey: queryKeys.localProvider });
      qc.invalidateQueries({ queryKey: queryKeys.models });
      activateProviderMode("local");
    },
    onError: (err) => {
      const detail = errorToMessage(err, t('failedSaveKey'));
      setLocalError(detail);
    },
  });

  const deleteLocalProvider = useMutation({
    mutationFn: () => api.delete<LocalProviderStatus>(API.CONFIG.LOCAL_PROVIDER),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.localProvider });
      qc.invalidateQueries({ queryKey: queryKeys.models });
      if (activeProvider === "local") {
        fallbackToOtherProviders();
      }
    },
    onError: (err) => {
      const detail = errorToMessage(err, t('failedSaveKey'));
      setLocalError(detail);
    },
  });

  const openaiDisconnectMutation = useMutation({
    mutationFn: () => api.delete(API.CONFIG.OPENAI_SUBSCRIPTION),
    onSuccess: () => {
      refetchOpenaiSub();
      qc.invalidateQueries({ queryKey: queryKeys.models });
      if (activeProvider === "chatgpt") {
        if (keyStatus?.is_configured) setActiveProvider("byok");
        else setActiveProvider(null);
      }
    },
  });

  const [openaiPolling, setOpenaiPolling] = useState(false);
  const [callbackUrlInput, setCallbackUrlInput] = useState("");
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopOpenaiPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    setOpenaiPolling(false);
  }, []);

  const startOpenaiPolling = useCallback(() => {
    stopOpenaiPolling();
    setOpenaiPolling(true);
    let consecutiveFailures = 0;
    const interval = setInterval(async () => {
      try {
        const status = await api.get<OpenAISubscriptionStatus>(API.CONFIG.OPENAI_SUBSCRIPTION);
        consecutiveFailures = 0;
        if (status.is_connected) {
          stopOpenaiPolling();
          refetchOpenaiSub();
          setActiveProvider("chatgpt");
          qc.invalidateQueries({ queryKey: queryKeys.models });
        }
      } catch (err) {
        consecutiveFailures += 1;
        console.warn("OpenAI subscription auth polling failed", err);
        if (consecutiveFailures >= 3) {
          stopOpenaiPolling();
        }
      }
    }, 2000);
    pollingIntervalRef.current = interval;
    pollingTimeoutRef.current = setTimeout(stopOpenaiPolling, 300_000);
  }, [qc, refetchOpenaiSub, setActiveProvider, stopOpenaiPolling]);

  useEffect(() => stopOpenaiPolling, [stopOpenaiPolling]);

  const openaiLoginMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.post<{ auth_url: string }>(API.CONFIG.OPENAI_SUBSCRIPTION_LOGIN, {});
      if (IS_DESKTOP) await desktopAPI.openExternal(resp.auth_url);
      else window.open(resp.auth_url, "_blank", "noopener,noreferrer");
    },
    onSuccess: startOpenaiPolling,
    onError: stopOpenaiPolling,
  });

  const manualCallbackMutation = useMutation({
    mutationFn: () => api.post<{ success: boolean; email: string }>(API.CONFIG.OPENAI_SUBSCRIPTION_MANUAL_CALLBACK, { callback_url: callbackUrlInput }),
    onSuccess: () => { setCallbackUrlInput(""); stopOpenaiPolling(); setActiveProvider("chatgpt"); qc.invalidateQueries({ queryKey: queryKeys.models }); },
  });

  interface OllamaRuntimeStatus { binary_installed: boolean; running: boolean; }
  const { data: ollamaRuntimeStatus } = useQuery({ queryKey: ["ollamaRuntime"], queryFn: () => api.get<OllamaRuntimeStatus>(API.OLLAMA.STATUS) });
  const ollamaConnected = !!ollamaRuntimeStatus?.running;

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-secondary)]">{t('providerModeDesc')}</p>

      {/* Provider cards */}
      <div className="grid grid-cols-3 gap-2">
        {([
          { mode: "byok" as ProviderMode, label: t('ownApiKey'), icon: Eye, connected: !!keyStatus?.is_configured || (providers ?? []).some((p) => p.is_configured && !p.id.startsWith("custom_")) },
          { mode: "chatgpt" as ProviderMode, label: t('chatgptSubscription'), icon: Eye, connected: !!openaiSubStatus?.is_connected },
          { mode: "ollama" as ProviderMode, label: "Ollama", icon: Cpu, connected: ollamaConnected },
          { mode: "local" as ProviderMode, label: t('localProvider'), icon: Server, connected: !!localStatus?.is_connected },
          { mode: "custom" as ProviderMode, label: t('customEndpoint'), icon: Plug, connected: (providers ?? []).some(p => p.id.startsWith("custom_") && p.is_configured) },
        ]).map(({ mode, label, icon: Icon, connected }) => (
          <button
            key={mode}
            onClick={() => { setViewingProvider(mode); if (connected) activateProviderMode(mode); }}
            className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors relative ${
              viewingProvider === mode
                ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
            }`}
          >
            <Icon className="h-5 w-5" />
            <span className="text-xs font-medium text-center leading-tight">{label}</span>
            {mounted && connected && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--color-success)]" />}
            {activeProvider === mode && mounted && connected && (
              <span className="absolute bottom-1 text-ui-3xs font-medium text-[var(--brand-primary)]">{t('activeProvider')}</span>
            )}
          </button>
        ))}
      </div>

      {/* Own API Key config */}
      {viewingProvider === "byok" && (
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-secondary)]">{t('byokDesc')}</p>

          {/* All BYOK providers (OpenRouter, OpenAI, Anthropic, Gemini, etc.) */}
          {(providers ?? []).filter(p => !p.id.startsWith("custom_")).map((p) => (
            <div key={p.id} className={`rounded-lg border p-3 space-y-2 transition-opacity ${
              p.is_configured && !p.enabled ? "border-[var(--border-default)] opacity-50" : "border-[var(--border-default)]"
            }`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-primary)]">{p.name}</span>
                <div className="flex items-center gap-2">
                  {p.is_configured && p.enabled && (
                    <span className="text-ui-3xs text-[var(--text-tertiary)]">{p.model_count} {t('providerModels')}</span>
                  )}
                  {p.is_configured && (
                    <button
                      type="button"
                      onClick={() => toggleProvider.mutate(p.id)}
                      disabled={toggleProvider.isPending}
                      className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                        p.enabled ? "bg-[var(--color-success)]" : "bg-[var(--surface-tertiary)]"
                      }`}
                      title={p.enabled ? t('disableProvider') : t('enableProvider')}
                    >
                      <span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
                        p.enabled ? "translate-x-3" : "translate-x-0"
                      }`} />
                    </button>
                  )}
                </div>
              </div>
              {p.is_configured && (
                <div className="flex items-center gap-2 text-xs">
                  <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
                  <span className="text-[var(--text-secondary)] font-mono">{p.masked_key}</span>
                  <button
                    onClick={() => deleteProviderKey.mutate(p.id)}
                    disabled={providerMutatingId === p.id}
                    className="ml-1 text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] transition-colors"
                    title={t('removeApiKey')}
                  >
                    {providerMutatingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  </button>
                </div>
              )}
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-2">
                  <div className="relative">
                    <Input
                      type={showProviderKey[p.id] ? "text" : "password"}
                      value={providerKeyInputs[p.id] ?? ""}
                      onChange={(e) => setProviderKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder={t(`providerKeyPlaceholder_${p.id}`, { defaultValue: `${p.name} API key` })}
                      className="pr-8 font-mono text-xs"
                      autoComplete="one-time-code"
                      data-form-type="other"
                    />
                    <button
                      type="button"
                      onClick={() => setShowProviderKey((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                    >
                      {showProviderKey[p.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateProviderKey.mutate({ id: p.id, apiKey: providerKeyInputs[p.id] ?? "" })}
                  disabled={!(providerKeyInputs[p.id] ?? "").trim() || providerMutatingId === p.id}
                >
                  {providerMutatingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('save')}
                </Button>
              </div>
              {providerError[p.id] && (
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{providerError[p.id]}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ChatGPT Subscription config */}
      {viewingProvider === "chatgpt" && (
        <div>
          <p className="text-xs text-[var(--text-secondary)] mb-3">{t('chatgptSubscriptionDesc')}</p>
          {openaiSubStatus?.is_connected ? (
            <div className="space-y-3">
              <div className={`rounded-lg border p-3 ${openaiSubStatus.needs_reauth ? "border-[var(--color-warning)]" : "border-[var(--border-default)]"}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">{openaiSubStatus.needs_reauth ? <AlertCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" /> : <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />}<span className="text-xs text-[var(--text-secondary)]">{openaiSubStatus.email || t('chatgptConnected')}</span></div>
                  <span className={`text-xs font-medium ${openaiSubStatus.needs_reauth ? "text-[var(--color-warning)]" : "text-[var(--color-success)]"}`}>{openaiSubStatus.needs_reauth ? t('chatgptNeedsReauth') : t('chatgptActive')}</span>
                </div>
              </div>
              <div className="flex gap-2">
                {openaiSubStatus.needs_reauth && <Button variant="outline" size="sm" onClick={() => openaiLoginMutation.mutate()} disabled={openaiLoginMutation.isPending || openaiPolling}>{(openaiLoginMutation.isPending || openaiPolling) ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RotateCw className="h-3.5 w-3.5 mr-1.5" />}{t('chatgptSignIn')}</Button>}
                <Button variant="ghost" size="sm" onClick={() => openaiDisconnectMutation.mutate()} disabled={openaiDisconnectMutation.isPending}>{openaiDisconnectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <LogOut className="h-3.5 w-3.5 mr-1.5" />}{t('disconnect')}</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Button variant="outline" size="sm" onClick={() => openaiLoginMutation.mutate()} disabled={openaiLoginMutation.isPending || openaiPolling}>{(openaiLoginMutation.isPending || openaiPolling) ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}{openaiPolling ? t('chatgptWaiting') : t('chatgptSignIn')}</Button>
              {openaiLoginMutation.isError && <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span>{t('chatgptLoginFailed')}</span></div>}
              {openaiPolling && (
                <div className="space-y-2 pt-2">
                  <p className="text-xs text-[var(--text-secondary)]">{t('chatgptPasteInstruction')}</p>
                  <div className="flex items-center gap-2">
                    <Input type="text" value={callbackUrlInput} onChange={(e) => setCallbackUrlInput(e.target.value)} placeholder={t('chatgptPastePlaceholder')} className="font-mono text-xs" />
                    <Button variant="outline" size="sm" onClick={() => manualCallbackMutation.mutate()} disabled={!callbackUrlInput.trim() || manualCallbackMutation.isPending}>{manualCallbackMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('chatgptSubmitCallback')}</Button>
                  </div>
                  {manualCallbackMutation.isError && <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span>{t('chatgptManualCallbackFailed')}</span></div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Ollama (Local LLM) config */}
      {viewingProvider === "ollama" && <OllamaPanel />}
      {/* Local OpenAI-compatible endpoint */}
      {viewingProvider === "local" && (
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-secondary)]">{t('localProviderDesc')}</p>
          {localStatus?.is_configured && (
            <div className="flex items-center gap-2 text-xs">
              <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
              <span className="text-[var(--text-secondary)] font-mono">{localStatus.base_url}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setLocalError(null); deleteLocalProvider.mutate(); }}
                disabled={deleteLocalProvider.isPending}
              >
                {deleteLocalProvider.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <LogOut className="h-3.5 w-3.5 mr-1" />}
                {t('disconnect')}
              </Button>
            </div>
          )}
          <div className="space-y-2">
            <Input
              type="text"
              value={localBaseUrlInput}
              onChange={(e) => setLocalBaseUrlInput(e.target.value)}
              placeholder={t('localProviderUrlPlaceholder')}
              className="font-mono text-xs"
              autoComplete="one-time-code"
              data-form-type="other"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  setLocalError(null);
                  updateLocalProvider.mutate(localBaseUrlInput.trim());
                }}
                disabled={!localBaseUrlInput.trim() || updateLocalProvider.isPending}
              >
                {updateLocalProvider.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                {t('save')}
              </Button>
            </div>
            {localError && (
              <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{localError}</span>
              </div>
            )}
            {localStatus?.status === "error" && (
              <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{t('localProviderConnectError')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Custom OpenAI-compatible endpoints */}
      {viewingProvider === "custom" && (() => {
        const customProviders = providers?.filter(p => p.id.startsWith("custom_")) || [];
        return (
          <div className="space-y-6">
            <p className="text-xs text-[var(--text-secondary)]">{t('customEndpointDesc')}</p>
            
            {customProviders.length > 0 && (
              <div className="space-y-4">
                <h4 className="text-xs font-semibold text-[var(--text-secondary)]">{t('savedEndpoints')}</h4>
                {customProviders.map((p) => (
                  <div key={p.id} className={`p-3 border border-[var(--border-primary)] rounded-lg bg-[var(--surface-secondary)] ${!p.enabled ? "opacity-50" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold">{p.name || t('customEndpoint')}</span>
                        <span className="text-[var(--text-secondary)] font-mono ml-2 text-ui-3xs bg-[var(--surface-primary)] px-2 py-0.5 rounded">{p.base_url}</span>
                        {p.masked_key && <span className="text-[var(--text-tertiary)] font-mono ml-2 text-ui-3xs">Key: {p.masked_key}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-ui-3xs text-[var(--text-tertiary)]">{p.model_count} models</span>
                        <button
                          type="button"
                          onClick={() => updateCustomEndpoint.mutate({ id: p.id, enabled: !p.enabled })}
                          disabled={updateCustomEndpoint.isPending}
                          className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                            p.enabled ? "bg-[var(--color-success)]" : "bg-[var(--surface-tertiary)]"
                          }`}
                          title={p.enabled ? t('disableProvider') : t('enableProvider')}
                        >
                          <span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
                            p.enabled ? "translate-x-3" : "translate-x-0"
                          }`} />
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[var(--color-destructive)] hover:text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
                          onClick={() => deleteCustomEndpoint.mutate(p.id)}
                          disabled={providerMutatingId === p.id}
                        >
                          {providerMutatingId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-4 pt-4 border-t border-[var(--border-primary)]">
              <h4 className="text-xs font-semibold text-[var(--text-secondary)]">{t('addNewCustomEndpoint')}</h4>
              <div className="space-y-3 p-3 bg-[var(--surface-secondary)] rounded-lg">
                <Input
                  type="text"
                  value={customEndpointName}
                  onChange={(e) => setCustomEndpointName(e.target.value)}
                  placeholder={t('endpointNamePlaceholder')}
                  className="text-xs bg-[var(--surface-primary)]"
                />
                <Input
                  type="text"
                  value={providerBaseUrlInputs["custom_new"] ?? ""}
                  onChange={(e) => setProviderBaseUrlInputs((prev) => ({ ...prev, ["custom_new"]: e.target.value }))}
                  placeholder={t('providerUrlPlaceholder_custom', { defaultValue: 'Base URL (e.g. https://api.myendpoint.com/v1)' })}
                  className="font-mono text-xs bg-[var(--surface-primary)]"
                />
                <div className="relative">
                  <Input
                    type={showProviderKey["custom_new"] ? "text" : "password"}
                    value={providerKeyInputs["custom_new"] ?? ""}
                    onChange={(e) => setProviderKeyInputs((prev) => ({ ...prev, ["custom_new"]: e.target.value }))}
                    placeholder={t('apiKeyPlaceholderOptional')}
                    className="pr-8 font-mono text-xs bg-[var(--surface-primary)]"
                    autoComplete="one-time-code"
                  />
                  <button
                    type="button"
                    onClick={() => setShowProviderKey((prev) => ({ ...prev, ["custom_new"]: !prev["custom_new"] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  >
                    {showProviderKey["custom_new"] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  {providerError["custom_new"] && (
                    <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span>{providerError["custom_new"]}</span>
                    </div>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    className="ml-auto"
                    onClick={() => createCustomEndpoint.mutate({ 
                      name: customEndpointName || "Custom Endpoint",
                      apiKey: providerKeyInputs["custom_new"] ?? "", 
                      baseUrl: providerBaseUrlInputs["custom_new"] ?? ""
                    })}
                    disabled={!(providerBaseUrlInputs["custom_new"] ?? "").trim() || providerMutatingId === "custom_new"}
                  >
                    {providerMutatingId === "custom_new" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                    {t('addEndpoint')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
