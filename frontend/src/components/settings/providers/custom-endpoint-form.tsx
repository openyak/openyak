"use client";

import { useState } from "react";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, queryKeys } from "@/lib/constants";
import type { ProviderInfo } from "@/types/usage";

function extractApiDetail(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  return errorToMessage(err, fallback);
}

/**
 * "Add new custom endpoint" form. Owns its own input state; on success the
 * fields reset and the providers/models queries invalidate so the parent
 * panel re-renders its saved-endpoint list.
 */
export function CustomEndpointForm() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createEndpoint = useMutation({
    mutationFn: () =>
      api.post<ProviderInfo>(API.CONFIG.CUSTOM_ENDPOINT, {
        name: name || "Custom Endpoint",
        api_key: apiKey,
        base_url: baseUrl,
      }),
    onSuccess: () => {
      setName("");
      setBaseUrl("");
      setApiKey("");
      setError(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err) => {
      setError(extractApiDetail(err, "Failed to save endpoint"));
    },
  });

  return (
    <div className="space-y-4 pt-4 border-t border-[var(--border-primary)]">
      <h4 className="text-xs font-semibold text-[var(--text-secondary)]">
        {t("addNewCustomEndpoint")}
      </h4>
      <div className="space-y-3 p-3 bg-[var(--surface-secondary)] rounded-lg">
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("endpointNamePlaceholder")}
          className="text-xs bg-[var(--surface-primary)]"
        />
        <Input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t("providerUrlPlaceholder_custom", {
            defaultValue: "Base URL (e.g. https://api.myendpoint.com/v1)",
          })}
          className="font-mono text-xs bg-[var(--surface-primary)]"
        />
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("apiKeyPlaceholderOptional")}
            className="pr-8 font-mono text-xs bg-[var(--surface-primary)]"
            autoComplete="one-time-code"
          />
          <button
            type="button"
            onClick={() => setShowKey((prev) => !prev)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          >
            {showKey ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="flex items-center justify-between">
          {error && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <Button
            variant="default"
            size="sm"
            className="ml-auto"
            onClick={() => createEndpoint.mutate()}
            disabled={!baseUrl.trim() || createEndpoint.isPending}
          >
            {createEndpoint.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : null}
            {t("addEndpoint")}
          </Button>
        </div>
      </div>
    </div>
  );
}
