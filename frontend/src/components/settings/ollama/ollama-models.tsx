"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { formatBytes, type OllamaModel } from "./types";

export function InstalledModelsList({
  models,
  onDeleted,
}: {
  models: OllamaModel[];
  onDeleted: () => void;
}) {
  const { t } = useTranslation("settings");
  const [deletingModel, setDeletingModel] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (name: string) => {
      setDeletingModel(name);
      return api.delete(API.OLLAMA.DELETE(name));
    },
    onSuccess: () => {
      setDeletingModel(null);
      onDeleted();
    },
    onError: () => setDeletingModel(null),
  });

  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border-default)] p-4 text-center">
        <p className="text-xs text-[var(--text-tertiary)]">
          {t("ollamaNoModels", "No models installed yet. Browse the library below to get started.")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-medium text-[var(--text-primary)] mb-2">
        {t("ollamaInstalled", "Installed Models")}
      </h3>
      <div className="space-y-1">
        {models.map((model) => (
          <div
            key={model.name}
            className="flex items-center justify-between rounded-md border border-[var(--border-default)] px-3 py-2"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] shrink-0" />
              <span className="text-xs font-mono truncate">{model.name}</span>
              <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                {formatBytes(model.size)}
              </span>
            </div>
            <button
              onClick={() => deleteMutation.mutate(model.name)}
              disabled={deletingModel === model.name}
              className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] transition-colors shrink-0 ml-2"
              title={t("delete", "Delete")}
            >
              {deletingModel === model.name ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
