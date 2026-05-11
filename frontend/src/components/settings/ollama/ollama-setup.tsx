"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertCircle, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { API } from "@/lib/constants";
import { LOCAL_MODEL_RECOMMENDATIONS } from "@/lib/local-models";

const SETUP_STREAM_IDLE_TIMEOUT_MS = 120_000;

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Ollama setup timed out while waiting for progress.")),
          SETUP_STREAM_IDLE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function SetupFlow({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation("settings");
  const [progress, setProgress] = useState<{
    status: string;
    completed?: number;
    total?: number;
    message?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startSetup = async () => {
    setError(null);
    setProgress({ status: "starting" });

    try {
      const resp = await apiFetch(API.OLLAMA.SETUP, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 120_000,
      });

      if (!resp.ok || !resp.body) {
        setError("Failed to start setup");
        setProgress(null);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await readWithIdleTimeout(reader);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              setProgress(data);
              if (data.status === "error") {
                setError(data.message || "Setup failed");
                setProgress(null);
                return;
              }
              if (data.status === "ready") {
                onComplete();
                return;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
      setError("Setup ended before Ollama became ready.");
      setProgress(null);
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  };

  const downloadPercent =
    progress?.total && progress.total > 0
      ? Math.round((progress.completed ?? 0) / progress.total * 100)
      : 0;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-secondary)]">
        {t("ollamaSetupDesc", "Ollama lets you run AI models locally on your computer. Set up takes about a minute.")}
      </p>

      {!progress ? (
        <Button variant="outline" size="sm" onClick={startSetup}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {t("ollamaSetup", "Set Up Ollama")}
          <span className="ml-1.5 text-[var(--text-tertiary)]">(~100 MB)</span>
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>
              {progress.status === "downloading"
                ? `Downloading... ${downloadPercent}%`
                : progress.status === "extracting"
                  ? "Extracting..."
                  : progress.status === "starting"
                    ? "Starting Ollama..."
                    : progress.status}
            </span>
          </div>
          {progress.status === "downloading" && progress.total && progress.total > 0 && (
            <div className="w-full bg-[var(--surface-tertiary)] rounded-full h-1.5">
              <div
                className="bg-[var(--brand-primary)] h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-destructive)]">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-2 pt-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-[var(--text-primary)]">
            Recommended local models
          </h3>
          <span className="text-ui-3xs text-[var(--text-tertiary)]">
            Same list maps to Rapid-MLX on macOS
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {LOCAL_MODEL_RECOMMENDATIONS.map((model) => (
            <div
              key={model.id}
              className="rounded-lg border border-[var(--border-default)] p-3 opacity-75"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                    {model.name}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-ui-3xs text-[var(--text-tertiary)]">
                    Default: {model.ollamaTag}
                  </div>
                </div>
                <span className="shrink-0 rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-ui-3xs text-[var(--text-tertiary)]">
                  {model.memory}
                </span>
              </div>
              <div className="mt-2 truncate rounded bg-[var(--surface-tertiary)] px-1.5 py-0.5 font-mono text-ui-3xs text-[var(--text-tertiary)]">
                MLX: {model.rapidMlxAlias ?? "none"}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {model.variants.map((variant) => (
                  <span
                    key={`${model.id}-${variant.label}`}
                    className="rounded border border-[var(--border-default)] px-1.5 py-0.5 text-ui-3xs text-[var(--text-tertiary)]"
                    title={variant.ollamaTag}
                  >
                    {variant.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
