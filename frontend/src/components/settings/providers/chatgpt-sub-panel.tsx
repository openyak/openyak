"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, LogOut, RotateCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { API, IS_DESKTOP, queryKeys } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import type { ApiKeyStatus } from "@/types/usage";

interface OpenAISubscriptionStatus {
  is_connected: boolean;
  email: string;
  needs_reauth?: boolean;
}

interface ChatGPTSubPanelProps {
  /** Used to decide fallback target when disconnecting an active ChatGPT sub. */
  keyStatus: ApiKeyStatus | undefined;
}

export function ChatGPTSubPanel({ keyStatus }: ChatGPTSubPanelProps) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const { activeProvider, setActiveProvider } = useSettingsStore();

  const { data: openaiSubStatus, refetch: refetchOpenaiSub } = useQuery({
    queryKey: queryKeys.openaiSubscription,
    queryFn: () =>
      api.get<OpenAISubscriptionStatus>(API.CONFIG.OPENAI_SUBSCRIPTION),
  });

  const [polling, setPolling] = useState(false);
  const [callbackUrlInput, setCallbackUrlInput] = useState("");
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    setPolling(false);
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    setPolling(true);
    let consecutiveFailures = 0;
    const interval = setInterval(async () => {
      try {
        const status = await api.get<OpenAISubscriptionStatus>(
          API.CONFIG.OPENAI_SUBSCRIPTION,
        );
        consecutiveFailures = 0;
        if (status.is_connected) {
          stopPolling();
          refetchOpenaiSub();
          setActiveProvider("chatgpt");
          qc.invalidateQueries({ queryKey: queryKeys.models });
        }
      } catch (err) {
        consecutiveFailures += 1;
        console.warn("OpenAI subscription auth polling failed", err);
        if (consecutiveFailures >= 3) {
          stopPolling();
        }
      }
    }, 2000);
    pollingIntervalRef.current = interval;
    pollingTimeoutRef.current = setTimeout(stopPolling, 300_000);
  }, [qc, refetchOpenaiSub, setActiveProvider, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

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

  const openaiLoginMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.post<{ auth_url: string }>(
        API.CONFIG.OPENAI_SUBSCRIPTION_LOGIN,
        {},
      );
      if (IS_DESKTOP) await desktopAPI.openExternal(resp.auth_url);
      else window.open(resp.auth_url, "_blank", "noopener,noreferrer");
    },
    onSuccess: startPolling,
    onError: stopPolling,
  });

  const manualCallbackMutation = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; email: string }>(
        API.CONFIG.OPENAI_SUBSCRIPTION_MANUAL_CALLBACK,
        { callback_url: callbackUrlInput },
      ),
    onSuccess: () => {
      setCallbackUrlInput("");
      stopPolling();
      setActiveProvider("chatgpt");
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
  });

  return (
    <div>
      <p className="text-xs text-[var(--text-secondary)] mb-3">
        {t("chatgptSubscriptionDesc")}
      </p>
      {openaiSubStatus?.is_connected ? (
        <div className="space-y-3">
          <div
            className={`rounded-lg border p-3 ${openaiSubStatus.needs_reauth ? "border-[var(--color-warning)]" : "border-[var(--border-default)]"}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {openaiSubStatus.needs_reauth ? (
                  <AlertCircle className="h-3.5 w-3.5 text-[var(--color-warning)]" />
                ) : (
                  <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
                )}
                <span className="text-xs text-[var(--text-secondary)]">
                  {openaiSubStatus.email || t("chatgptConnected")}
                </span>
              </div>
              <span
                className={`text-xs font-medium ${openaiSubStatus.needs_reauth ? "text-[var(--color-warning)]" : "text-[var(--color-success)]"}`}
              >
                {openaiSubStatus.needs_reauth
                  ? t("chatgptNeedsReauth")
                  : t("chatgptActive")}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            {openaiSubStatus.needs_reauth && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openaiLoginMutation.mutate()}
                disabled={openaiLoginMutation.isPending || polling}
              >
                {openaiLoginMutation.isPending || polling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t("chatgptSignIn")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openaiDisconnectMutation.mutate()}
              disabled={openaiDisconnectMutation.isPending}
            >
              {openaiDisconnectMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <LogOut className="h-3.5 w-3.5 mr-1.5" />
              )}
              {t("disconnect")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openaiLoginMutation.mutate()}
            disabled={openaiLoginMutation.isPending || polling}
          >
            {openaiLoginMutation.isPending || polling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : null}
            {polling ? t("chatgptWaiting") : t("chatgptSignIn")}
          </Button>
          {openaiLoginMutation.isError && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{t("chatgptLoginFailed")}</span>
            </div>
          )}
          {polling && (
            <div className="space-y-2 pt-2">
              <p className="text-xs text-[var(--text-secondary)]">
                {t("chatgptPasteInstruction")}
              </p>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={callbackUrlInput}
                  onChange={(e) => setCallbackUrlInput(e.target.value)}
                  placeholder={t("chatgptPastePlaceholder")}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => manualCallbackMutation.mutate()}
                  disabled={
                    !callbackUrlInput.trim() ||
                    manualCallbackMutation.isPending
                  }
                >
                  {manualCallbackMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t("chatgptSubmitCallback")
                  )}
                </Button>
              </div>
              {manualCallbackMutation.isError && (
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("chatgptManualCallbackFailed")}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
