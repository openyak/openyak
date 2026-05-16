"use client";

import { useState } from "react";
import { AlertCircle, Loader2, LogOut } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, queryKeys } from "@/lib/constants";
import type { LocalProviderStatus, ProviderInfo } from "@/types/usage";
import { CustomEndpointForm } from "@/components/settings/providers/custom-endpoint-form";

function extractApiDetail(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  return errorToMessage(err, fallback);
}

interface CustomEndpointPanelProps {
  providers: ProviderInfo[] | undefined;
  localStatus: LocalProviderStatus | undefined;
  /** Invoked after the legacy local provider is deleted, so parent can fall back. */
  onLocalDeleted: () => void;
}

export function CustomEndpointPanel({
  providers,
  localStatus,
  onLocalDeleted,
}: CustomEndpointPanelProps) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();

  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<Record<string, string>>(
    {},
  );

  const deleteCustomEndpoint = useMutation({
    mutationFn: async (id: string) => {
      setMutatingId(id);
      return api.delete<ProviderInfo>(API.CONFIG.CUSTOM_ENDPOINT_ITEM(id));
    },
    onSuccess: () => {
      setMutatingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: () => setMutatingId(null),
  });

  const updateCustomEndpoint = useMutation({
    mutationFn: async ({
      id,
      enabled,
    }: {
      id: string;
      enabled?: boolean;
    }) => {
      setMutatingId(id);
      const body: Record<string, unknown> = {};
      if (enabled !== undefined) body.enabled = enabled;
      return api.patch<ProviderInfo>(
        API.CONFIG.CUSTOM_ENDPOINT_ITEM(id),
        body,
      );
    },
    onSuccess: () => {
      setMutatingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err, { id }) => {
      setMutatingId(null);
      setProviderError((prev) => ({
        ...prev,
        [id]: extractApiDetail(err, "Failed to update endpoint"),
      }));
    },
  });

  const deleteLocalProvider = useMutation({
    mutationFn: () =>
      api.delete<LocalProviderStatus>(API.CONFIG.LOCAL_PROVIDER),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.localProvider });
      qc.invalidateQueries({ queryKey: queryKeys.models });
      setProviderError((prev) => {
        const next = { ...prev };
        delete next["local_legacy"];
        return next;
      });
      onLocalDeleted();
    },
    onError: (err) => {
      const detail = errorToMessage(err, t("failedSaveKey"));
      setProviderError((prev) => ({ ...prev, ["local_legacy"]: detail }));
    },
  });

  const customProviders =
    providers?.filter((p) => p.id.startsWith("custom_")) ?? [];
  const hasLegacyLocal = !!localStatus?.is_configured;

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-secondary)]">
        {t("customEndpointDesc")}
      </p>

      {(hasLegacyLocal || customProviders.length > 0) && (
        <div className="space-y-4">
          <h4 className="text-xs font-semibold text-[var(--text-secondary)]">
            {t("savedEndpoints")}
          </h4>
          {hasLegacyLocal && (
            <div
              className={`p-3 border border-[var(--border-primary)] rounded-lg bg-[var(--surface-secondary)] ${localStatus?.status === "error" ? "border-[var(--color-destructive)]/40" : ""}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="font-semibold">{t("localProvider")}</span>
                  <span className="text-[var(--text-secondary)] font-mono ml-2 text-ui-3xs bg-[var(--surface-primary)] px-2 py-0.5 rounded truncate">
                    {localStatus?.base_url}
                  </span>
                  {localStatus?.status === "error" && (
                    <span className="text-[var(--color-destructive)] text-ui-3xs">
                      {t("localProviderConnectError")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[var(--color-destructive)] hover:text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
                    onClick={() => deleteLocalProvider.mutate()}
                    disabled={deleteLocalProvider.isPending}
                  >
                    {deleteLocalProvider.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <LogOut className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>
              {providerError["local_legacy"] && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{providerError["local_legacy"]}</span>
                </div>
              )}
            </div>
          )}
          {customProviders.map((p) => (
            <div
              key={p.id}
              className={`p-3 border border-[var(--border-primary)] rounded-lg bg-[var(--surface-secondary)] ${!p.enabled ? "opacity-50" : ""}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold">
                    {p.name || t("customEndpoint")}
                  </span>
                  <span className="text-[var(--text-secondary)] font-mono ml-2 text-ui-3xs bg-[var(--surface-primary)] px-2 py-0.5 rounded">
                    {p.base_url}
                  </span>
                  {p.masked_key && (
                    <span className="text-[var(--text-tertiary)] font-mono ml-2 text-ui-3xs">
                      Key: {p.masked_key}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-ui-3xs text-[var(--text-tertiary)]">
                    {p.model_count} models
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      updateCustomEndpoint.mutate({
                        id: p.id,
                        enabled: !p.enabled,
                      })
                    }
                    disabled={updateCustomEndpoint.isPending}
                    className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                      p.enabled
                        ? "bg-[var(--color-success)]"
                        : "bg-[var(--surface-tertiary)]"
                    }`}
                    title={
                      p.enabled
                        ? t("disableProvider")
                        : t("enableProvider")
                    }
                  >
                    <span
                      className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
                        p.enabled ? "translate-x-3" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[var(--color-destructive)] hover:text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
                    onClick={() => deleteCustomEndpoint.mutate(p.id)}
                    disabled={mutatingId === p.id}
                  >
                    {mutatingId === p.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <LogOut className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <CustomEndpointForm />
    </div>
  );
}
