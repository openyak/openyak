"use client";

import { useState } from "react";
import { AlertCircle, Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, queryKeys } from "@/lib/constants";
import type { ProviderInfo } from "@/types/usage";

interface ByokPanelProps {
  providers: ProviderInfo[] | undefined;
  onSaved: () => void;
}

export function ByokPanel({ providers, onSaved }: ByokPanelProps) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<Record<string, string>>(
    {},
  );

  const updateProviderKey = useMutation({
    mutationFn: async ({ id, apiKey }: { id: string; apiKey: string }) => {
      setMutatingId(id);
      return api.post<ProviderInfo>(API.CONFIG.PROVIDER_KEY(id), {
        api_key: apiKey,
      });
    },
    onSuccess: (_data, { id }) => {
      setKeyInputs((prev) => ({ ...prev, [id]: "" }));
      setProviderError((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setMutatingId(null);
      onSaved();
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err, { id }) => {
      setMutatingId(null);
      const detail = errorToMessage(err, t("failedSaveKey"));
      setProviderError((prev) => ({ ...prev, [id]: detail }));
    },
  });

  const deleteProviderKey = useMutation({
    mutationFn: async (id: string) => {
      setMutatingId(id);
      return api.delete<ProviderInfo>(API.CONFIG.PROVIDER_KEY(id));
    },
    onSuccess: () => {
      setMutatingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: () => setMutatingId(null),
  });

  const toggleProvider = useMutation({
    mutationFn: (id: string) =>
      api.post<ProviderInfo>(API.CONFIG.PROVIDER_TOGGLE(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
  });

  const byokProviders = (providers ?? []).filter(
    (p) => !p.id.startsWith("custom_"),
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--text-secondary)]">{t("byokDesc")}</p>

      {byokProviders.map((p) => (
        <div
          key={p.id}
          className={`rounded-lg border p-3 space-y-2 transition-opacity ${
            p.is_configured && !p.enabled
              ? "border-[var(--border-default)] opacity-50"
              : "border-[var(--border-default)]"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-primary)]">
              {p.name}
            </span>
            <div className="flex items-center gap-2">
              {p.is_configured && p.enabled && (
                <span className="text-ui-3xs text-[var(--text-tertiary)]">
                  {p.model_count} {t("providerModels")}
                </span>
              )}
              {p.is_configured && (
                <button
                  type="button"
                  onClick={() => toggleProvider.mutate(p.id)}
                  disabled={toggleProvider.isPending}
                  className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                    p.enabled
                      ? "bg-[var(--color-success)]"
                      : "bg-[var(--surface-tertiary)]"
                  }`}
                  title={
                    p.enabled ? t("disableProvider") : t("enableProvider")
                  }
                >
                  <span
                    className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
                      p.enabled ? "translate-x-3" : "translate-x-0"
                    }`}
                  />
                </button>
              )}
            </div>
          </div>
          {p.is_configured && (
            <div className="flex items-center gap-2 text-xs">
              <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
              <span className="text-[var(--text-secondary)] font-mono">
                {p.masked_key}
              </span>
              <button
                onClick={() => deleteProviderKey.mutate(p.id)}
                disabled={mutatingId === p.id}
                className="ml-1 text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] transition-colors"
                title={t("removeApiKey")}
              >
                {mutatingId === p.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          )}
          <div className="flex items-start gap-2">
            <div className="flex-1 space-y-2">
              <div className="relative">
                <Input
                  type={showKey[p.id] ? "text" : "password"}
                  value={keyInputs[p.id] ?? ""}
                  onChange={(e) =>
                    setKeyInputs((prev) => ({
                      ...prev,
                      [p.id]: e.target.value,
                    }))
                  }
                  placeholder={t(`providerKeyPlaceholder_${p.id}`, {
                    defaultValue: `${p.name} API key`,
                  })}
                  className="pr-8 font-mono text-xs"
                  autoComplete="one-time-code"
                  data-form-type="other"
                />
                <button
                  type="button"
                  onClick={() =>
                    setShowKey((prev) => ({
                      ...prev,
                      [p.id]: !prev[p.id],
                    }))
                  }
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                >
                  {showKey[p.id] ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                updateProviderKey.mutate({
                  id: p.id,
                  apiKey: keyInputs[p.id] ?? "",
                })
              }
              disabled={
                !(keyInputs[p.id] ?? "").trim() || mutatingId === p.id
              }
            >
              {mutatingId === p.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("save")
              )}
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
  );
}
