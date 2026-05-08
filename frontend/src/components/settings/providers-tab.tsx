"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, X, Check, Loader2, AlertCircle, LogOut, CreditCard, Mail, RotateCw, Cpu, Server, Plug } from "lucide-react";
import { OpenYakLogo } from "@/components/ui/openyak-logo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsStore } from "@/stores/settings-store";
import { useAuthStore, type OpenYakUser } from "@/stores/auth-store";
import { api, apiFetch, ApiError } from "@/lib/api";
import { proxyApi, ProxyApiError } from "@/lib/proxy-api";
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

interface ProvidersTabProps {
  onNavigateTab?: (tab: string) => void;
}

export function ProvidersTab({ onNavigateTab }: ProvidersTabProps) {
  const { t } = useTranslation('settings');
  const { activeProvider, setActiveProvider } = useSettingsStore();
  const authStore = useAuthStore();

  type ProviderMode = "openyak" | "byok" | "ollama" | "local" | "custom";
  const [viewingProvider, setViewingProvider] = useState<ProviderMode>(
    () => (activeProvider as ProviderMode) ?? "openyak"
  );

  const [mounted, setMounted] = useState(false);
  const qc = useQueryClient();
  const { data: allModels } = useModels();

  const [proxyUrlInput] = useState(
    process.env.NEXT_PUBLIC_DEFAULT_PROXY_URL || "https://api.open-yak.com",
  );
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [verificationStep, setVerificationStep] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [localBaseUrlInput, setLocalBaseUrlInput] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const syncOpenYakAccountToBackend = async (proxyUrl: string, token: string, refreshToken?: string) => {
    const payload = { proxy_url: proxyUrl, token, ...(refreshToken && { refresh_token: refreshToken }) };
    try {
      await api.post(API.CONFIG.OPENYAK_ACCOUNT, payload);
    } catch {
      if (IS_DESKTOP) {
        await desktopAPI.getBackendUrl();
        const res = await apiFetch(API.CONFIG.OPENYAK_ACCOUNT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          timeoutMs: 30_000,
        });
        if (res.ok) return;
      }
      throw new Error("Failed to connect local backend");
    }
  };

  const completeAuth = async (proxyUrl: string, tokens: { access_token: string; refresh_token: string }) => {
    const res = await fetch(`${proxyUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) throw new Error("Failed to fetch profile");
    const user = (await res.json()) as OpenYakUser;
    await syncOpenYakAccountToBackend(proxyUrl, tokens.access_token, tokens.refresh_token);
    authStore.setAuth({ proxyUrl, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, user });
    setActiveProvider("openyak");
    qc.invalidateQueries({ queryKey: queryKeys.apiKeyStatus });
    qc.invalidateQueries({ queryKey: queryKeys.models });
    setEmailInput(""); setPasswordInput(""); setCodeInput(""); setVerificationStep(false);
  };

  const loginMutation = useMutation({
    mutationFn: async () => {
      const proxyUrl = proxyUrlInput.replace(/\/$/, "");
      if (authMode === "login") {
        const tokens = await proxyApi.authPost<{ access_token: string; refresh_token: string }>(proxyUrl, "/api/auth/login", { email: emailInput, password: passwordInput });
        await completeAuth(proxyUrl, tokens);
        return { type: "done" as const };
      } else {
        await proxyApi.authPost<{ message: string; email: string }>(proxyUrl, "/api/auth/register", { email: emailInput, password: passwordInput });
        return { type: "verification" as const };
      }
    },
    onSuccess: (data) => { if (data.type === "verification") setVerificationStep(true); },
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const proxyUrl = proxyUrlInput.replace(/\/$/, "");
      const tokens = await proxyApi.authPost<{ access_token: string; refresh_token: string }>(proxyUrl, "/api/auth/verify", { email: emailInput, code: codeInput });
      await completeAuth(proxyUrl, tokens);
    },
  });

  const resendMutation = useMutation({
    mutationFn: async () => {
      const proxyUrl = proxyUrlInput.replace(/\/$/, "");
      await proxyApi.authPost(proxyUrl, "/api/auth/resend", { email: emailInput });
    },
    onSuccess: () => setCodeInput(""),
  });

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
    if (authStore.isConnected) {
      setActiveProvider("openyak");
    } else if (keyStatus?.is_configured || (providers ?? []).some((p) => p.is_configured)) {
      setActiveProvider("byok");
    } else {
      setActiveProvider(null);
    }
  };

  const pickModelForMode = (mode: ProviderMode, models: ModelInfo[] | undefined) => {
    if (!models || models.length === 0) return null;
    if (mode === "byok") {
      return models.find((m) => !["openyak-proxy", "ollama"].includes(m.provider_id)) ?? null;
    }
    if (mode === "openyak") {
      return models.find((m) => m.provider_id === "openyak-proxy") ?? null;
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

  const disconnectMutation = useMutation({
    mutationFn: () => api.delete(API.CONFIG.OPENYAK_ACCOUNT),
    onSuccess: () => {
      authStore.logout();
      qc.invalidateQueries({ queryKey: queryKeys.models });
      qc.invalidateQueries({ queryKey: queryKeys.openyakAccount });
      if (activeProvider === "openyak") {
        if (keyStatus?.is_configured) setActiveProvider("byok");
        else setActiveProvider(null);
      }
    },
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

  interface OllamaRuntimeStatus { binary_installed: boolean; running: boolean; }
  const { data: ollamaRuntimeStatus } = useQuery({ queryKey: ["ollamaRuntime"], queryFn: () => api.get<OllamaRuntimeStatus>(API.OLLAMA.STATUS) });
  const ollamaConnected = !!ollamaRuntimeStatus?.running;

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-secondary)]">{t('providerModeDesc')}</p>

      {/* Provider cards */}
      <div className="grid grid-cols-3 gap-2">
        {([
          { mode: "openyak" as ProviderMode, label: t('openyakAccount'), icon: Eye, connected: authStore.isConnected },
          { mode: "byok" as ProviderMode, label: t('ownApiKey'), icon: Eye, connected: !!keyStatus?.is_configured || (providers ?? []).some((p) => p.is_configured && !p.id.startsWith("custom_")) },
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
            {mode === "openyak" ? <OpenYakLogo size={20} /> : <Icon className="h-5 w-5" />}
            <span className="text-xs font-medium text-center leading-tight">{label}</span>
            {mounted && connected && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--color-success)]" />}
            {activeProvider === mode && mounted && connected && (
              <span className="absolute bottom-1 text-ui-3xs font-medium text-[var(--brand-primary)]">{t('activeProvider')}</span>
            )}
          </button>
        ))}
      </div>

      {/* OpenYak Account config */}
      {viewingProvider === "openyak" && (
        <div>
          <p className="text-xs text-[var(--text-secondary)] mb-3">{t('openyakAccountDesc')}</p>
          {authStore.isConnected && authStore.user ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-[var(--border-default)] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
                    <span className="text-xs text-[var(--text-secondary)]">{authStore.user.email}</span>
                  </div>
                  <span className="text-xs font-medium text-[var(--text-primary)]">
                    {authStore.user.billing_mode === "credits"
                      ? `$${(authStore.user.credit_balance / 100).toFixed(2)}`
                      : `Free: ${Math.round(authStore.user.daily_free_tokens_used / 1000)}K / ${Math.round(authStore.user.daily_free_token_limit / 1000)}K tokens`}
                  </span>
                </div>
                {authStore.user.billing_mode === "free" && (
                  <div className="w-full bg-[var(--surface-tertiary)] rounded-full h-1.5">
                    <div className="bg-[var(--brand-primary)] h-1.5 rounded-full transition-all" style={{ width: `${Math.min(100, (authStore.user.daily_free_tokens_used / authStore.user.daily_free_token_limit) * 100)}%` }} />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onNavigateTab?.("billing")}><CreditCard className="h-3.5 w-3.5 mr-1.5" />{t('buyCredits')}</Button>
                <Button variant="ghost" size="sm" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}><LogOut className="h-3.5 w-3.5 mr-1.5" />{t('disconnect')}</Button>
              </div>
            </div>
          ) : verificationStep ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"><Mail className="h-3.5 w-3.5" /><span>{t('verificationSent')} <strong>{emailInput}</strong></span></div>
              <Input type="text" value={codeInput} onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder={t('sixDigitCode')} className="font-mono text-center text-lg tracking-[0.3em]" maxLength={6} autoFocus />
              <div className="flex items-center gap-2">
                <Button variant="default" size="sm" onClick={() => verifyMutation.mutate()} disabled={codeInput.length !== 6 || verifyMutation.isPending}>{verifyMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('verify')}</Button>
                <Button variant="ghost" size="sm" onClick={() => resendMutation.mutate()} disabled={resendMutation.isPending}>{resendMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><RotateCw className="h-3.5 w-3.5 mr-1" />{t('resend')}</>}</Button>
                <button onClick={() => { setVerificationStep(false); setCodeInput(""); }} className="text-xs text-[var(--text-tertiary)] hover:underline ml-auto">{t('back')}</button>
              </div>
              {verifyMutation.isError && <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span>{errorToMessage(verifyMutation.error, t('verificationFailed'))}</span></div>}
              {resendMutation.isSuccess && <div className="flex items-center gap-1.5 text-xs text-[var(--color-success)]"><Check className="h-3.5 w-3.5 shrink-0" /><span>{t('newCodeSent')}</span></div>}
            </div>
          ) : (
            <div className="space-y-3">
              <Input type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} placeholder="Email" className="text-xs" autoComplete="one-time-code" data-form-type="other" />
              <Input type="password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} placeholder="Password (min 8 characters)" className="text-xs" autoComplete="one-time-code" data-form-type="other" />
              <div className="flex items-center gap-2">
                <Button variant="default" size="sm" onClick={() => loginMutation.mutate()} disabled={!emailInput || !passwordInput || loginMutation.isPending}>{loginMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : authMode === "login" ? t('signIn') : t('createAccount')}</Button>
                <button onClick={() => setAuthMode(authMode === "login" ? "register" : "login")} className="text-xs text-[var(--brand-primary)] hover:underline">{authMode === "login" ? t('createAccountLink') : t('alreadyHaveAccount')}</button>
              </div>
              {loginMutation.isError && <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span>{errorToMessage(loginMutation.error, loginMutation.error instanceof ProxyApiError ? t('authFailed') : t('connectionFailed'))}</span></div>}
            </div>
          )}
        </div>
      )}

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
