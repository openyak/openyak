"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Sparkles,
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

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/;

interface ModelRow {
  id: string;
  name: string;
}

interface HeaderRow {
  name: string;
  value: string;
}

interface CreatePayload {
  slug: string;
  name: string;
  base_url: string;
  api_key?: string;
  models: CustomEndpointModel[];
  headers: Record<string, string>;
}

function extractApiDetail(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  return errorToMessage(err, fallback);
}

/**
 * "Add new custom endpoint" form (opencode-style). Owns its own state and
 * resets on success. Layout mirrors the screenshot: Provider ID slug,
 * Display name, Base URL, API key, repeating Models, repeating Headers.
 */
export function CustomEndpointForm() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();

  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<ModelRow[]>([{ id: "", name: "" }]);
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { name: "", value: "" },
  ]);
  const [error, setError] = useState<string | null>(null);

  const slugError = useMemo(() => {
    if (!slug) return null;
    if (!SLUG_RE.test(slug)) {
      return t("customSlugInvalid", {
        defaultValue:
          "Slug must start with a letter/digit; only lowercase letters, digits, hyphens, or underscores (max 50 chars).",
      });
    }
    return null;
  }, [slug, t]);

  const createEndpoint = useMutation({
    mutationFn: (payload: CreatePayload) =>
      api.post<ProviderInfo>(API.CONFIG.CUSTOM_ENDPOINT, payload),
    onSuccess: () => {
      setSlug("");
      setDisplayName("");
      setBaseUrl("");
      setApiKey("");
      setModels([{ id: "", name: "" }]);
      setHeaders([{ name: "", value: "" }]);
      setError(null);
      qc.invalidateQueries({ queryKey: queryKeys.providers });
      qc.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err) => {
      setError(extractApiDetail(err, t("failedSaveEndpoint", {
        defaultValue: "Failed to save endpoint",
      })));
    },
  });

  const handleSubmit = () => {
    setError(null);
    const trimmedSlug = slug.trim().toLowerCase();
    if (!SLUG_RE.test(trimmedSlug)) {
      setError(
        t("customSlugInvalid", {
          defaultValue:
            "Slug must start with a letter/digit; only lowercase letters, digits, hyphens, or underscores (max 50 chars).",
        }),
      );
      return;
    }
    if (!baseUrl.trim()) return;

    const cleanedModels: CustomEndpointModel[] = models
      .map((m) => ({ id: m.id.trim(), name: m.name.trim() || null }))
      .filter((m) => m.id.length > 0);

    const headerMap: Record<string, string> = {};
    for (const h of headers) {
      const n = h.name.trim();
      if (n.length === 0) continue;
      headerMap[n] = h.value;
    }

    createEndpoint.mutate({
      slug: trimmedSlug,
      name: displayName.trim() || trimmedSlug,
      base_url: baseUrl.trim(),
      api_key: apiKey.trim() || undefined,
      models: cleanedModels,
      headers: headerMap,
    });
  };

  const updateModel = (idx: number, patch: Partial<ModelRow>) => {
    setModels((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    );
  };
  const addModel = () =>
    setModels((prev) => [...prev, { id: "", name: "" }]);
  const removeModel = (idx: number) =>
    setModels((prev) =>
      prev.length === 1
        ? [{ id: "", name: "" }]
        : prev.filter((_, i) => i !== idx),
    );

  const updateHeader = (idx: number, patch: Partial<HeaderRow>) => {
    setHeaders((prev) =>
      prev.map((h, i) => (i === idx ? { ...h, ...patch } : h)),
    );
  };
  const addHeader = () =>
    setHeaders((prev) => [...prev, { name: "", value: "" }]);
  const removeHeader = (idx: number) =>
    setHeaders((prev) =>
      prev.length === 1
        ? [{ name: "", value: "" }]
        : prev.filter((_, i) => i !== idx),
    );

  const submitDisabled =
    !slug.trim() ||
    !!slugError ||
    !baseUrl.trim() ||
    createEndpoint.isPending;

  return (
    <div className="space-y-5 pt-4 border-t border-[var(--border-primary)]">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-[var(--text-secondary)]" />
        <h4 className="text-xs font-semibold">
          {t("customProviderFormTitle", { defaultValue: "Custom provider" })}
        </h4>
      </div>
      <p className="text-xs text-[var(--text-secondary)]">
        {t("customProviderFormDesc", {
          defaultValue:
            "Configure an OpenAI-compatible provider with full control over slug, models, and request headers.",
        })}
      </p>

      <div className="space-y-5 p-4 bg-[var(--surface-secondary)] rounded-lg">
        {/* Provider ID */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[var(--text-secondary)]">
            {t("customProviderIdLabel", { defaultValue: "Provider ID" })}
          </label>
          <Input
            type="text"
            value={slug}
            onChange={(e) =>
              setSlug(e.target.value.toLowerCase().replace(/\s+/g, ""))
            }
            placeholder={t("customProviderIdPlaceholder", {
              defaultValue: "myprovider",
            })}
            className="font-mono text-xs bg-[var(--surface-primary)]"
            autoComplete="off"
            spellCheck={false}
          />
          <p
            className={`text-ui-3xs ${slugError ? "text-[var(--color-destructive)]" : "text-[var(--text-tertiary)]"}`}
          >
            {slugError ??
              t("customProviderIdHelp", {
                defaultValue:
                  "Lowercase letters, numbers, hyphens, or underscores",
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
            placeholder={t("providerUrlPlaceholder_custom", {
              defaultValue: "https://api.myprovider.com/v1",
            })}
            className="font-mono text-xs bg-[var(--surface-primary)]"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* API key */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[var(--text-secondary)]">
            {t("customApiKeyLabel", { defaultValue: "API key" })}
          </label>
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
            {t("customApiKeyHelp", {
              defaultValue:
                "Optional. Leave empty if you manage auth via headers.",
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
              {t("customModelsHelp", {
                defaultValue: "Leave empty to auto-discover via /v1/models",
              })}
            </span>
          </div>
          <div className="space-y-2">
            {models.map((m, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={m.id}
                  onChange={(e) => updateModel(idx, { id: e.target.value })}
                  placeholder={t("customModelIdPlaceholder", {
                    defaultValue: "model-id",
                  })}
                  className="font-mono text-xs bg-[var(--surface-primary)] flex-1"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Input
                  type="text"
                  value={m.name}
                  onChange={(e) => updateModel(idx, { name: e.target.value })}
                  placeholder={t("customModelDisplayPlaceholder", {
                    defaultValue: "Display Name",
                  })}
                  className="text-xs bg-[var(--surface-primary)] flex-1"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => removeModel(idx)}
                  className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] p-1"
                  aria-label={t("remove", { defaultValue: "Remove" })}
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
            {t("customAddModel", { defaultValue: "Add model" })}
          </button>
        </div>

        {/* Headers */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-[var(--text-secondary)]">
              {t("customHeadersLabel", {
                defaultValue: "Headers (optional)",
              })}
            </label>
          </div>
          <div className="space-y-2">
            {headers.map((h, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={h.name}
                  onChange={(e) => updateHeader(idx, { name: e.target.value })}
                  placeholder={t("customHeaderNamePlaceholder", {
                    defaultValue: "Header-Name",
                  })}
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
                  placeholder={t("customHeaderValuePlaceholder", {
                    defaultValue: "value",
                  })}
                  className="font-mono text-xs bg-[var(--surface-primary)] flex-1"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => removeHeader(idx)}
                  className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] p-1"
                  aria-label={t("remove", { defaultValue: "Remove" })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addHeader}
            className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("customAddHeader", { defaultValue: "Add header" })}
          </button>
        </div>

        {/* Footer: error + submit */}
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="min-h-[1rem] flex-1">
            {error && (
              <div className="flex items-start gap-1.5 text-xs text-[var(--color-destructive)]">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            disabled={submitDisabled}
          >
            {createEndpoint.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : null}
            {t("submit", { defaultValue: "Submit" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
