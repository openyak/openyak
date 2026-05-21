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

/** Existing header — name is immutable; user can replace value or delete. */
interface ExistingHeaderRow {
  kind: "existing";
  name: string;
  maskedValue: string;
  newValue: string; // empty = keep current; non-empty = upsert
  deleted: boolean;
}

/** Net-new header added in this edit session. */
interface NewHeaderRow {
  kind: "new";
  name: string;
  value: string;
}

type HeaderRow = ExistingHeaderRow | NewHeaderRow;

interface PatchPayload {
  name?: string;
  base_url?: string;
  api_key?: string;
  models?: CustomEndpointModel[];
  /** JSON Merge Patch delta — null marks a key for deletion. */
  headers?: Record<string, string | null>;
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
 * 3. Headers pre-fill as rows of existing keys (name locked, value blank
 *    with a masked placeholder for reference). Each row tracks its own
 *    intent — keep, replace, or delete — and the submit builds a
 *    JSON Merge Patch delta so untouched rows aren't sent. This lets the
 *    user add or change one header without re-typing the others' values,
 *    which the GET response can't echo back unmasked.
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
  // Set when the user explicitly opts to wipe the existing api_key.
  // We can't infer "clear" from an empty input field — that's
  // semantically "leave unchanged" so add/edit-headers-only flows
  // don't accidentally erase the key.
  const [clearApiKey, setClearApiKey] = useState(false);

  const [models, setModels] = useState<ModelRow[]>(() => {
    const existing = endpoint.models ?? [];
    if (existing.length === 0) return [{ id: "", name: "" }];
    return existing.map((m) => ({ id: m.id, name: m.name ?? "" }));
  });

  // Snapshot the masked values for placeholder display — never sent back.
  const maskedHeaders = useMemo(
    () => endpoint.headers ?? {},
    [endpoint.headers],
  );
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => {
    const existingEntries = Object.entries(maskedHeaders);
    if (existingEntries.length === 0) {
      return [{ kind: "new", name: "", value: "" }];
    }
    return existingEntries.map(
      ([name, masked]): ExistingHeaderRow => ({
        kind: "existing",
        name,
        maskedValue: masked,
        newValue: "",
        deleted: false,
      }),
    );
  });

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

    if (clearApiKey && !apiKey.trim()) {
      // Explicit clear: send empty string so the backend wipes the
      // stored key. The visible input being empty isn't enough on its
      // own — that path means "no change".
      payload.api_key = "";
    } else if (apiKey.trim()) {
      payload.api_key = apiKey.trim();
    }

    // Build a JSON Merge Patch delta — untouched existing rows are
    // omitted, so they survive on the backend even if the user only
    // changed one header. ``null`` marks a deletion.
    const headersDelta: Record<string, string | null> = {};
    for (const row of headerRows) {
      if (row.kind === "existing") {
        if (row.deleted) {
          headersDelta[row.name] = null;
        } else if (row.newValue.length > 0) {
          headersDelta[row.name] = row.newValue;
        }
        // else: untouched — omit so backend preserves it.
      } else {
        const n = row.name.trim();
        if (n.length > 0 && row.value.length > 0) {
          headersDelta[n] = row.value;
        }
      }
    }
    if (Object.keys(headersDelta).length > 0) {
      payload.headers = headersDelta;
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

  const updateExistingValue = (idx: number, newValue: string) => {
    setHeaderRows((prev) =>
      prev.map((row, i) =>
        i === idx && row.kind === "existing" ? { ...row, newValue } : row,
      ),
    );
  };
  const updateNewName = (idx: number, name: string) => {
    setHeaderRows((prev) =>
      prev.map((row, i) =>
        i === idx && row.kind === "new" ? { ...row, name } : row,
      ),
    );
  };
  const updateNewValue = (idx: number, value: string) => {
    setHeaderRows((prev) =>
      prev.map((row, i) =>
        i === idx && row.kind === "new" ? { ...row, value } : row,
      ),
    );
  };
  const addHeader = () => {
    setHeaderRows((prev) => [...prev, { kind: "new", name: "", value: "" }]);
  };
  const removeHeader = (idx: number) => {
    setHeaderRows((prev) => {
      const row = prev[idx];
      if (!row) return prev;
      if (row.kind === "existing") {
        // Mark for deletion but keep the row out of the visual list so
        // the user can keep adding new rows. The deleted name still
        // contributes a ``null`` to the submit delta.
        return prev.map((r, i) =>
          i === idx && r.kind === "existing" ? { ...r, deleted: true } : r,
        );
      }
      return prev.filter((_, i) => i !== idx);
    });
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

      {/* API key — unchanged unless filled or explicitly cleared */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-[var(--text-secondary)]">
            {t("customApiKeyLabel", { defaultValue: "API key" })}
          </label>
          {endpoint.masked_key && !clearApiKey && (
            <button
              type="button"
              onClick={() => {
                setClearApiKey(true);
                setApiKey("");
              }}
              className="text-ui-3xs text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] underline-offset-2 hover:underline"
            >
              {t("customApiKeyClear", { defaultValue: "Clear key" })}
            </button>
          )}
          {clearApiKey && (
            <button
              type="button"
              onClick={() => setClearApiKey(false)}
              className="text-ui-3xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
            >
              {t("undo", { defaultValue: "Undo" })}
            </button>
          )}
        </div>
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              if (e.target.value && clearApiKey) setClearApiKey(false);
            }}
            placeholder={
              clearApiKey
                ? t("customApiKeyClearedPlaceholder", {
                    defaultValue: "Key will be removed on save",
                  })
                : endpoint.masked_key
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
        <p
          className={`text-ui-3xs ${
            clearApiKey
              ? "text-[var(--color-destructive)]"
              : "text-[var(--text-tertiary)]"
          }`}
        >
          {clearApiKey
            ? t("customApiKeyClearedHelp", {
                defaultValue:
                  "Saving will wipe the stored key. Type a new key to replace instead.",
              })
            : t("customApiKeyEditHelp", {
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

      {/* Headers — per-row edit; untouched rows survive on the backend */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-[var(--text-secondary)]">
          {t("customHeadersLabel", { defaultValue: "Headers (optional)" })}
        </label>
        <p className="text-ui-3xs text-[var(--text-tertiary)]">
          {t("customHeadersEditHint", {
            defaultValue:
              "Leave a value blank to keep it. Trash deletes the header. Add new rows below.",
          })}
        </p>
        <div className="space-y-2">
          {headerRows.map((row, idx) => {
            if (row.kind === "existing" && row.deleted) {
              return null;
            }
            if (row.kind === "existing") {
              return (
                <div key={`existing-${row.name}`} className="flex items-center gap-2">
                  <div className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--surface-primary)] border border-[var(--border-primary)] text-xs font-mono text-[var(--text-tertiary)]">
                    <Lock className="h-3 w-3 shrink-0" />
                    <span className="truncate">{row.name}</span>
                  </div>
                  <Input
                    type="text"
                    value={row.newValue}
                    onChange={(e) =>
                      updateExistingValue(idx, e.target.value)
                    }
                    placeholder={t("customHeaderValueExistingPlaceholder", {
                      defaultValue: "{{masked}} (leave blank to keep)",
                      masked: row.maskedValue || "••••",
                    })}
                    className="font-mono text-xs bg-[var(--surface-primary)] flex-1"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(idx)}
                    className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] p-1"
                    aria-label={t("remove")}
                    title={t("customHeaderDeleteTitle", {
                      defaultValue: "Delete this header",
                    })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            }
            return (
              <div key={`new-${idx}`} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={row.name}
                  onChange={(e) => updateNewName(idx, e.target.value)}
                  placeholder={t("customHeaderNamePlaceholder")}
                  className="font-mono text-xs bg-[var(--surface-primary)] flex-1"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Input
                  type="text"
                  value={row.value}
                  onChange={(e) => updateNewValue(idx, e.target.value)}
                  placeholder={t("customHeaderValuePlaceholder")}
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
