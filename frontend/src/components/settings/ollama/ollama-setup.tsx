"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertCircle, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API, getBackendUrl } from "@/lib/constants";

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
      const backendUrl = await getBackendUrl();
      const resp = await fetch(`${backendUrl}${API.OLLAMA.SETUP}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        const { done, value } = await reader.read();
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
    </div>
  );
}
