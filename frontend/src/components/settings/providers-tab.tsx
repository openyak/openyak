"use client";

import { useState, useRef } from "react";
import { Eye, EyeOff, X, Check, Loader2, AlertCircle, LogOut, CreditCard, Mail, RotateCw, Cpu } from "lucide-react";
import { OpenYakLogo } from "@/components/ui/openyak-logo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsStore, type ActiveProvider } from "@/stores/settings-store";
import { useAuthStore, type OpenYakUser } from "@/stores/auth-store";
import { api, ApiError } from "@/lib/api";
import { proxyApi, ProxyApiError } from "@/lib/proxy-api";
import { API, IS_DESKTOP, queryKeys } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";
import type { ApiKeyStatus } from "@/types/usage";
import { OllamaPanel } from "@/components/settings/ollama-panel";

interface OpenAISubscriptionStatus {
  is_connected: boolean;
  email: string;
  needs_reauth?: boolean;
}

interface ProvidersTabProps {
  onNavigateTab?: (tab: string) => void;
}

export function ProvidersTab({ onNavigateTab }: ProvidersTabProps) {
  const { t } = useTranslation('settings');
  const { activeProvider, setActiveProvider } = useSettingsStore();
  const authStore = useAuthStore();

  type ProviderMode = "openyak" | "byok" | "chatgpt" | "ollama";
  const [viewingProvider, setViewingProvider] = useState<ProviderMode>(
    () => (activeProvider as ProviderMode) ?? "openyak"
  );

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const qc = useQueryClient();

  const [proxyUrlInput, setProxyUrlInput] = useState(
    process.env.NEXT_PUBLIC_DEFAULT_PROXY_URL || "https://api.open-yak.com",
  );
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [verificationStep, setVerificationStep] = useState(false);
  const [codeInput, setCodeInput] = useState("");

  const syncOpenYakAccountToBackend = async (proxyUrl: string, token: string, refreshToken?: string) => {
    const payload = { proxy_url: proxyUrl, token, ...(refreshToken && { refresh_token: refreshToken }) };
    try {
      await api.post(API.CONFIG.OPENYAK_ACCOUNT, payload);
    } catch {
      if (IS_DESKTOP) {
        const backendUrl = await desktopAPI.getBackendUrl();
        const res = await fetch(`${backendUrl}${API.CONFIG.OPENYAK_ACCOUNT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

  const { data: openaiSubStatus, refetch: refetchOpenaiSub } = useQuery({
    queryKey: queryKeys.openaiSubscription,
    queryFn: () => api.get<OpenAISubscriptionStatus>(API.CONFIG.OPENAI_SUBSCRIPTION),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.delete(API.CONFIG.OPENYAK_ACCOUNT),
    onSuccess: () => {
      authStore.logout();
      qc.invalidateQueries({ queryKey: queryKeys.models });
      qc.invalidateQueries({ queryKey: queryKeys.openyakAccount });
      if (activeProvider === "openyak") {
        if (openaiSubStatus?.is_connected) setActiveProvider("chatgpt");
        else if (keyStatus?.is_configured) setActiveProvider("byok");
        else setActiveProvider(null);
      }
    },
  });

  const updateKey = useMutation({
    mutationFn: (apiKey: string) => api.post<ApiKeyStatus>(API.CONFIG.API_KEY, { api_key: apiKey }),
    onSuccess: () => { setActiveProvider("byok"); qc.invalidateQueries({ queryKey: queryKeys.openyakAccount }); qc.invalidateQueries({ queryKey: queryKeys.models }); setApiKeyInput(""); },
  });

  const deleteKey = useMutation({
    mutationFn: () => api.delete<ApiKeyStatus>(API.CONFIG.API_KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.apiKeyStatus });
      qc.invalidateQueries({ queryKey: queryKeys.models });
      if (activeProvider === "byok") {
        if (authStore.isConnected) setActiveProvider("openyak");
        else if (openaiSubStatus?.is_connected) setActiveProvider("chatgpt");
        else setActiveProvider(null);
      }
    },
  });

  const openaiLoginMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.post<{ auth_url: string }>(API.CONFIG.OPENAI_SUBSCRIPTION_LOGIN, {});
      if (IS_DESKTOP) await desktopAPI.openExternal(resp.auth_url);
      else window.open(resp.auth_url, "_blank", "noopener,noreferrer");
    },
  });

  const openaiDisconnectMutation = useMutation({
    mutationFn: () => api.delete(API.CONFIG.OPENAI_SUBSCRIPTION),
    onSuccess: () => {
      refetchOpenaiSub();
      qc.invalidateQueries({ queryKey: queryKeys.models });
      if (activeProvider === "chatgpt") {
        if (authStore.isConnected) setActiveProvider("openyak");
        else if (keyStatus?.is_configured) setActiveProvider("byok");
        else setActiveProvider(null);
      }
    },
  });

  const [openaiPolling, setOpenaiPolling] = useState(false);
  const [callbackUrlInput, setCallbackUrlInput] = useState("");
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startOpenaiPolling = () => {
    setOpenaiPolling(true);
    const interval = setInterval(async () => {
      const status = await api.get<OpenAISubscriptionStatus>(API.CONFIG.OPENAI_SUBSCRIPTION);
      if (status.is_connected) {
        clearInterval(interval);
        pollingIntervalRef.current = null;
        setOpenaiPolling(false);
        refetchOpenaiSub();
        setActiveProvider("chatgpt");
        qc.invalidateQueries({ queryKey: queryKeys.models });
      }
    }, 2000);
    pollingIntervalRef.current = interval;
    setTimeout(() => { clearInterval(interval); if (pollingIntervalRef.current === interval) pollingIntervalRef.current = null; setOpenaiPolling(false); }, 300_000);
  };

  const manualCallbackMutation = useMutation({
    mutationFn: () => api.post<{ success: boolean; email: string }>(API.CONFIG.OPENAI_SUBSCRIPTION_MANUAL_CALLBACK, { callback_url: callbackUrlInput }),
    onSuccess: () => { setCallbackUrlInput(""); setOpenaiPolling(false); setActiveProvider("chatgpt"); qc.invalidateQueries({ queryKey: queryKeys.models }); },
  });

  interface OllamaRuntimeStatus { binary_installed: boolean; running: boolean; }
  const { data: ollamaRuntimeStatus } = useQuery({ queryKey: ["ollamaRuntime"], queryFn: () => api.get<OllamaRuntimeStatus>(API.OLLAMA.STATUS) });
  const ollamaConnected = !!ollamaRuntimeStatus?.running;

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-secondary)]">{t('providerModeDesc')}</p>

      {/* Provider cards */}
      <div className="grid grid-cols-4 gap-2">
        {([
          { mode: "openyak" as ProviderMode, label: t('openyakAccount'), icon: Eye, connected: authStore.isConnected },
          { mode: "byok" as ProviderMode, label: t('ownApiKey'), icon: Eye, connected: !!keyStatus?.is_configured },
          { mode: "chatgpt" as ProviderMode, label: t('chatgptSubscription'), icon: CreditCard, connected: !!openaiSubStatus?.is_connected },
          { mode: "ollama" as ProviderMode, label: "Ollama", icon: Cpu, connected: ollamaConnected },
        ]).map(({ mode, label, icon: Icon, connected }) => (
          <button
            key={mode}
            onClick={() => { setViewingProvider(mode); if (connected) setActiveProvider(mode); }}
            className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors relative ${
              viewingProvider === mode
                ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
            }`}
          >
            {mode === "openyak" ? <OpenYakLogo size={20} /> : <Icon className="h-5 w-5" />}
            <span className="text-xs font-medium text-center leading-tight">{label}</span>
            {connected && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--color-success)]" />}
            {activeProvider === mode && connected && (
              <span className="absolute bottom-1 text-[9px] font-medium text-[var(--brand-primary)]">{t('activeProvider')}</span>
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
              {verifyMutation.isError && <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span>{verifyMutation.error instanceof ProxyApiError ? ((verifyMutation.error.body as any)?.detail ?? t('verificationFailed')) : t('verificationFailed')}</span></div>}
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
              {loginMutation.isError && <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span>{loginMutation.error instanceof ProxyApiError ? ((loginMutation.error.body as any)?.detail ?? t('authFailed')) : t('connectionFailed')}</span></div>}
            </div>
          )}
        </div>
      )}

      {/* Own API Key config */}
      {viewingProvider === "byok" && (
        <div>
          <p className="text-xs text-[var(--text-secondary)] mb-3">{t('apiKeyDesc')}{" "}<a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-[var(--brand-primary)] underline">openrouter.ai/keys</a>.</p>
          {keyStatus?.is_configured && (
            <div className="flex items-center gap-2 mb-3 text-xs">
              <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
              <span className="text-[var(--text-secondary)] font-mono">{keyStatus.masked_key}</span>
              <button onClick={() => deleteKey.mutate()} disabled={deleteKey.isPending} className="ml-1 text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] transition-colors" title={t('removeApiKey')}>{deleteKey.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}</button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input type={showKey ? "text" : "password"} value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="sk-or-..." className="pr-8 font-mono text-xs" autoComplete="one-time-code" data-form-type="other" />
              <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
            </div>
            <Button variant="outline" size="sm" onClick={() => updateKey.mutate(apiKeyInput)} disabled={!apiKeyInput.trim() || updateKey.isPending}>{updateKey.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('save')}</Button>
          </div>
          {updateKey.isError && <div className="flex items-center gap-1.5 mt-2 text-xs text-[var(--color-destructive)]"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span>{updateKey.error instanceof ApiError ? ((updateKey.error.body as any)?.detail ?? t('failedSaveKey')) : t('failedSaveKey')}</span></div>}
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
                {openaiSubStatus.needs_reauth && <Button variant="outline" size="sm" onClick={() => { openaiLoginMutation.mutate(); startOpenaiPolling(); }} disabled={openaiLoginMutation.isPending || openaiPolling}>{(openaiLoginMutation.isPending || openaiPolling) ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RotateCw className="h-3.5 w-3.5 mr-1.5" />}{t('chatgptSignIn')}</Button>}
                <Button variant="ghost" size="sm" onClick={() => openaiDisconnectMutation.mutate()} disabled={openaiDisconnectMutation.isPending}>{openaiDisconnectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <LogOut className="h-3.5 w-3.5 mr-1.5" />}{t('disconnect')}</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Button variant="outline" size="sm" onClick={() => { openaiLoginMutation.mutate(); startOpenaiPolling(); }} disabled={openaiLoginMutation.isPending || openaiPolling}>{(openaiLoginMutation.isPending || openaiPolling) ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}{openaiPolling ? t('chatgptWaiting') : t('chatgptSignIn')}</Button>
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
    </div>
  );
}
