"use client";

import { useState, useEffect, useCallback } from "react";
import { Sun, Moon, Monitor, RefreshCw, Check } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { IS_DESKTOP } from "@/lib/constants";

export function GeneralTab() {
  const { t, i18n } = useTranslation('settings');
  const { theme, setTheme } = useTheme();
  const [appVersion, setAppVersion] = useState("0.0.1");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "up-to-date" | "downloading" | "error">("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion().then(setAppVersion)
    ).catch(() => {});
  }, []);

  const checkForUpdate = useCallback(async () => {
    if (!IS_DESKTOP) return;
    setUpdateStatus("checking");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateVersion(update.version);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("up-to-date");
        setTimeout(() => setUpdateStatus("idle"), 3000);
      }
    } catch (e) {
      console.warn("Update check failed (expected in dev mode):", e);
      setUpdateStatus("up-to-date");
      setTimeout(() => setUpdateStatus("idle"), 3000);
    }
  }, []);

  const doUpdate = useCallback(async () => {
    if (!IS_DESKTOP) return;
    setUpdateStatus("downloading");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return;
      let totalLength = 0;
      let downloaded = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await update.downloadAndInstall((event: any) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalLength = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength ?? 0;
          if (totalLength > 0) setDownloadProgress(Math.round((downloaded / totalLength) * 100));
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      setUpdateStatus("error");
      setTimeout(() => setUpdateStatus("idle"), 3000);
    }
  }, []);

  return (
    <div className="space-y-8">
      {/* Theme Section */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('appearance')}
        </h2>
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: "light", label: t('light'), icon: Sun },
            { value: "dark", label: t('dark'), icon: Moon },
            { value: "system", label: t('system'), icon: Monitor },
          ].map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                theme === value
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                  : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* Language Section */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('language')}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: "en", label: "English" },
            { value: "zh", label: "中文" },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => {
                i18n.changeLanguage(value);
                localStorage.setItem("openyak-language", value);
              }}
              className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                i18n.language.startsWith(value)
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                  : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
              }`}
            >
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* About */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('about')}
        </h2>
        <div className="text-xs text-[var(--text-secondary)] space-y-1">
          <p>{t('aboutVersion', { version: appVersion })}</p>
          <p>{t('aboutDesc')}</p>
          <p>{t('aboutCopyright')}</p>
        </div>
        {IS_DESKTOP && (
          <div className="mt-3">
            {updateStatus === "idle" && (
              <Button variant="outline" size="sm" className="text-xs h-7" onClick={checkForUpdate}>
                {t('checkForUpdates')}
              </Button>
            )}
            {updateStatus === "checking" && (
              <Button variant="outline" size="sm" className="text-xs h-7" disabled>
                <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
                {t('checkForUpdates')}
              </Button>
            )}
            {updateStatus === "up-to-date" && (
              <Button variant="outline" size="sm" className="text-xs h-7 text-green-500 border-green-500/30" disabled>
                <Check className="h-3 w-3 mr-1.5" />
                {t('upToDate')}
              </Button>
            )}
            {updateStatus === "available" && (
              <Button size="sm" className="text-xs h-7" onClick={doUpdate}>
                {t('updateNow')} — v{updateVersion}
              </Button>
            )}
            {updateStatus === "downloading" && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-32 rounded-full bg-[var(--surface-secondary)] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--brand-primary)] transition-all duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
                <span className="text-xs text-[var(--text-secondary)]">{downloadProgress}%</span>
              </div>
            )}
            {updateStatus === "error" && (
              <Button variant="outline" size="sm" className="text-xs h-7 text-[var(--color-destructive)]" onClick={checkForUpdate}>
                {t('checkForUpdates')}
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
