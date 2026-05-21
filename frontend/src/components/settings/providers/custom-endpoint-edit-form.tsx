"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Plus,
  Trash2,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { errorToMessage } from "@/lib/errors";
import { API, queryKeys } from "@/lib/constants";
import type {
  CustomEndpointModel,
  ProviderInfo,
} from "@/types/usage";

interface ModelRow {
  id: string;
  name: string;
}

interface HeaderRow {
  name: string;
  value: string;
}

interface PatchPayload {
  name?: string;
  base_url?: string;
  api_key?: string;
  models?: CustomEndpointModel[];
  headers?: Record<string, string>;
}

interface CustomEndpointEditFormProps {
  endpoint: ProviderInfo;
  onClose: () => void;
}

function extractApiDetail(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  return errorToMessage(err, fallback);
}

/**
 * Edit form for an existing custom endpoint.
 *
 * Semantics differ from the create form in three places:
 * 1. Slug is shown as a locked, read-only chip — the backend treats it as
 *    immutable (it's the provider ID).
 * 2. API key is blank by default. Empty submit ⇒ field is omitted from the
 *    PATCH so the backend keeps the existing key.
 * 3. Headers pre-fill the existing names but leave values blank (the GET
 *    response only returns masked values). The section is only sent when the
 *    user actually touches it; otherwise existing headers are preserved.
 */
export function CustomEndpointEditForm({
  endpoint,
  onClose,
}: CustomEndpointEditFormProps) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();

  const [displayName, setDisplayName] = useState(endpoint.name || "");
  const [baseUrl, setBaseUrl] = useState(endpoint.base_url || "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [models, setModels] = useState<ModelRow[]>(() => {
    const existing = endpoint.models ?? [];
    if (existing.length === 0) return [{ id: "", name: "" }];
    return existing.map((m) => ({ id: m.id, name: m.name ?? "" }));
  });

  // Snapshot the masked values for hint display only — never sent back.
  const maskedHeaders = useMemo(
    () => endpoint.headers ?? {},
    [endpoint.headers],
  );
  const [headers, setHeaders] = useState<HeaderRow[]>(() => {
    const names = Object.keys(maskedHeaders);
    if (names.length === 0) return [{ name: "", value: "" }];
    return names.map((n) => ({ name: n, value: "" }));
  });
  const [headersDirty, setHeadersDirty] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const updateEndpoint = useMutation({
    mutationFn: (payload: PatchPayload) =>
      api.patch<ProviderInfo>(
        API.CONFIG.CUSTOM_ENDPOINT_ITEM(endpoint.id),
        payload,
      ),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
      onClose();
    },
    onError: (err) => {
      setError(
        extractApiDetail(
          err,
          t("failedSaveEndpoint", { defaultValue: "Failed to save endpoint" }),
        ),
      );
    },
  });

  const handleSubmit = () => {
    setError(null);
    if (!baseUrl.trim()) {
      setError(
        t("customBaseUrlRequired", {
          defaultValue: "Base URL is required.",
        }),
      );
      return;
    }

    const payload: PatchPayload = {
      name: displayName.trim() || endpoint.slug || endpoint.name,
      base_url: baseUrl.trim(),
      models: models
        .map((m) => ({ id: m.id.trim(), name: m.name.trim() || null }))
        .filter((m) => m.id.length > 0),
    };

    if (apiKey.trim()) {
      payload.api_key = apiKey.trim();
    }

    if (headersDirty) {
      const headerMap: Record<string, string> = {};
      for (const h of headers) {
        const n = h.name.trim();
        if (n.length === 0) continue;
        if (h.value.length === 0) continue;
        headerMap[n] = h.value;
      }
      payload.headers = headerMap;
    }

    updateEndpoint.mutate(payload);
  };

  const updateModel = (idx: number, patch: Partial<ModelRow>) =>
    setModels((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    );
  const addModel = () =>
    setModels((prev) => [...prev, { id: "", name: "" }]);
  const removeModel = (idx: number) =>
    setModels((prev) =>
      prev.length === 1
        ? [{ id: "", name: "" }]
        : prev.filter((_, i) => i !== idx),
    );

  const markHeadersDirty = () => {
    if (!headersDirty) setHeadersDirty(true);
  };
  const updateHeader = (idx: number, patch: Partial<HeaderRow>) => {
    markHeadersDirty();
    setHeaders((prev) =>
      prev.map((h, i) => (i === idx ? { ...h, ...patch } : h)),
    );
  };
  const addHeader = () => {
    markHeadersDirty();
    setHeaders((prev) => [...prev, { name: "", value: "" }]);
  };
  const removeHeader = (idx: number) => {
    markHeadersDirty();
    setHeaders((prev) =>
      prev.length === 1
        ? [{ name: "", value: "" }]
        : prev.filter((_, i) => i !== idx),
    );
  };

  const submitDisabled = !baseUrl.trim() || updateEndpoint.isPending;

  return (
    <div className="mt-3 space-y-5 p-4 bg-[var(--surface-secondary)] rounded-lg border border-[var(--border-primary)]">
      <h4 className="text-xs font-semibold">
        {t("customEndpointEditTitle", { defaultValue: "Edit custom endpoint" })}
      </h4>

      {/* Provider ID — locked */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[var(--text-secondary)]">
          {t("customProviderIdLabel", { defaultValue: "Provider ID" })}
        </label>
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[var(--surface-primary)] border border-[var(--border-primary)] text-xs font-mono text-[var(--text-tertiary)]">
          <Lock className="h-3 w-3 shrink-0" />
          <span className="truncate">{endpoint.slug ?? endpoint.id}</span>
        </div>
        <p className="text-ui-3xs text-[var(--text-tertiary)]">
          {t("customSlugLockedHelp", {
            defaultValue:
              "Provider ID cannot be changed. Delete and recreate to rename.",
          })}
        </p>
      </div>

      {/* Display name */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[var(--text-secondary)]">
          {t("customDisplayNameLabel", { defaultValue: "Display name" })}
        </label>
        <Input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t("customDisplayNamePlaceholder", {
            defaultValue: "My AI Provider",
          })}
          className="text-xs bg-[var(--surface-primary)]"
        />
      </div>

      {/* Base URL */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[var(--text-secondary)]">
          {t("customBaseUrlLabel", { defaultValue: "Base URL" })}
        </label>
        <Input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t("providerUrlPlaceholder_custom")}
          className="font-mono text-xs bg-[var(--surface-primary)]"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* API key — unchanged unless filled */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[var(--text-secondary)]">
          {t("customApiKeyLabel", { defaultValue: "API key" })}
        </label>
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              endpoint.masked_key
                ? t("customApiKeyEditPlaceholderExisting", {
                    defaultValue: "{{masked}} (leave blank to keep)",
                    masked: endpoint.masked_key,
                  })
                : t("customApiKeyEditPlaceholderEmpty", {
                    defaultValue: "Enter a key to add one (optional)",
                  })
            }
            className="pr-8 font-mono text-xs bg-[var(--surface-primary)]"
            autoComplete="one-time-code"
          />
          <button
            type="button"
            onClick={() => setShowKey((p) => !p)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          >
            {showKey ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <p className="text-ui-3xs text-[var(--text-tertiary)]">
          {t("customApiKeyEditHelp", {
            defaultValue: "Leave blank to keep the existing key.",
          })}
        </p>
      </div>

      {/* Models */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-[var(--text-secondary)]">
            {t("customModelsLabel", { defaultValue: "Models" })}
          </label>
          <span className="text-ui-3xs text-[var(--text-tertiary)]">
            {t("customModelsHelp")}
          </span>
        </div>
        <div className="space-y-2">
          {models.map((m, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                type="text"
                value={m.id}
                onChange={(e) => updateModel(idx, { id: e.target.value })}
                placeholder={t("customModelIdPlaceholder")}
                className="font-mono text-xs bg-[var(--surface-primary)] flex-1"
                autoComplete="off"
                spellCheck={false}
              />
              <Input
                type="text"
                value={m.name}
                onChange={(e) => updateModel(idx, { name: e.target.value })}
                placeholder={t("customModelDisplayPlaceholder")}
                className="text-xs bg-[var(--surface-primary)] flex-1"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => removeModel(idx)}
                className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] p-1"
                aria-label={t("remove")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addModel}
          className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("customAddModel")}
        </button>
      </div>

      {/* Headers — unchanged unless touched */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-[var(--text-secondary)]">
          {t("customHeadersLabel", { defaultValue: "Headers (optional)" })}
        </label>
        {!headersDirty && (
          <p className="text-ui-3xs text-[var(--text-tertiary)]">
            {t("customHeadersEditHelp", {
              defaultValue:
                "Existing values are hidden. Touch any field to replace the full set; leave untouched to keep them as-is.",
            })}
          </p>
        )}
        {headersDirty && (
          <p className="text-ui-3xs text-[var(--color-destructive)]">
            {t("customHeadersDirtyWarning", {
              defaultValue:
                "Headers will be replaced entirely. Re-enter values for any headers you want to keep.",
            })}
          </p>
        )}
        <div className="space-y-2">
          {headers.map((h, idx) => {
            const maskedExisting = maskedHeaders[h.name.trim()];
            return (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={h.name}
                  onChange={(e) =>
                    updateHeader(idx, { name: e.target.value })
                  }
                  placeholder={t("customHeaderNamePlaceholder")}
                  className="font-mono text-xs bg-[var(--surface-primary)] flex-1"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Input
                  type="text"
                  value={h.value}
                  onChange={(e) =>
                    updateHeader(idx, { value: e.target.value })
                  }
                  placeholder={
                    maskedExisting
                      ? t("customHeaderValueExistingPlaceholder", {
                          defaultValue: "{{masked}} (re-enter to keep)",
                          masked: maskedExisting,
                        })
                      : t("customHeaderValuePlaceholder")
                  }
                  className="font-mono text-xs bg-[var(--surface-primary)] flex-1"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => removeHeader(idx)}
                  className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] p-1"
                  aria-label={t("remove")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={addHeader}
          className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("customAddHeader")}
        </button>
      </div>

      {/* Footer */}
      <div className="flex items-start justify-between gap-3 pt-1">
        <div className="min-h-[1rem] flex-1">
          {error && (
            <div className="flex items-start gap-1.5 text-xs text-[var(--color-destructive)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={updateEndpoint.isPending}
          >
            {t("cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            disabled={submitDisabled}
          >
            {updateEndpoint.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : null}
            {t("saveChanges", { defaultValue: "Save changes" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
