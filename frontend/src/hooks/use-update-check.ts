"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { IS_DESKTOP } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";

const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
const STARTUP_DELAY = 5000; // 5 seconds

interface UpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
  downloading: boolean;
  progress: number;
  downloadAndInstall: () => Promise<void>;
  dismiss: () => void;
  checkNow: () => Promise<void>;
}

export function useUpdateCheck(): UpdateInfo {
  const [available, setAvailable] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateRef = useRef<any>(null);

  const checkNow = useCallback(async () => {
    if (!IS_DESKTOP) return;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        const dismissedVersion = localStorage.getItem("openyak-dismissed-update");
        if (dismissedVersion === update.version) return;
        updateRef.current = update;
        setVersion(update.version);
        setNotes(update.body ?? null);
        setAvailable(true);
        setDismissed(false);
      }
    } catch (e) {
      console.warn("Update check failed:", e);
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setDownloading(true);
    let totalLength = 0;
    let downloaded = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await update.downloadAndInstall((event: any) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalLength = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength ?? 0;
          if (totalLength > 0) setProgress(Math.round((downloaded / totalLength) * 100));
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      setDownloading(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    if (version) localStorage.setItem("openyak-dismissed-update", version);
    setDismissed(true);
    setAvailable(false);
  }, [version]);

  useEffect(() => {
    if (!IS_DESKTOP) return;

    const timeout = setTimeout(checkNow, STARTUP_DELAY);
    const interval = setInterval(checkNow, CHECK_INTERVAL);
    const cleanup = desktopAPI.onCheckForUpdates(() => {
      checkNow();
    });

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
      cleanup();
    };
  }, [checkNow]);

  return {
    available: available && !dismissed,
    version,
    notes,
    downloading,
    progress,
    downloadAndInstall,
    dismiss,
    checkNow,
  };
}
