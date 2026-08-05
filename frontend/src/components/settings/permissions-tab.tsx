"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore, type SavedPermissionRule } from "@/stores/settings-store";
import { apiFetch } from "@/lib/api";
import { API, IS_DESKTOP } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";

type CapabilityState = "granted" | "denied" | "not_applicable" | "unknown";

interface ComputerCapabilityStatus {
  platform: "macos" | "windows" | "linux" | "unsupported";
  supported: boolean;
  interaction_mode: "background" | "foreground" | "unsupported";
  accessibility: CapabilityState;
  screen_recording: CapabilityState;
  runtime: "available" | "missing" | "unsupported";
  settings_url: string | null;
}

function formatTime(timestamp: number) {
  if (!timestamp) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function ruleLabel(rule: SavedPermissionRule) {
  if (rule.tool === "bash") return "Shell";
  if (rule.tool === "write") return "Write";
  if (rule.tool === "edit") return "Edit";
  if (rule.tool === "read") return "Read";
  return rule.tool;
}

function AccessRow({
  label,
  state,
  grantedLabel,
  deniedLabel,
  unknownLabel,
}: {
  label: string;
  state: CapabilityState;
  grantedLabel: string;
  deniedLabel: string;
  unknownLabel: string;
}) {
  if (state === "not_applicable") return null;
  const granted = state === "granted";
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          granted
            ? "text-[var(--color-success)]"
            : state === "denied"
              ? "text-[var(--color-warning)]"
              : "text-[var(--text-tertiary)]",
        )}
      >
        {granted ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <CircleAlert className="h-3.5 w-3.5" />
        )}
        {granted ? grantedLabel : state === "denied" ? deniedLabel : unknownLabel}
      </span>
    </div>
  );
}

export function PermissionsTab() {
  const { t } = useTranslation("settings");
  const savedPermissions = useSettingsStore((s) => s.savedPermissions);
  const clearPermissionRule = useSettingsStore((s) => s.clearPermissionRule);
  const computerUseEnabled = useSettingsStore((s) => s.computerUseEnabled);
  const setComputerUseEnabled = useSettingsStore((s) => s.setComputerUseEnabled);
  const browserUseEnabled = useSettingsStore((s) => s.browserUseEnabled);
  const setBrowserUseEnabled = useSettingsStore((s) => s.setBrowserUseEnabled);
  const [computerStatus, setComputerStatus] = useState<ComputerCapabilityStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);

  const alwaysAllowedApps = useMemo(
    () => savedPermissions.filter(
      (rule) => rule.tool === "computer" && rule.allow && !["*", "system"].includes(rule.pattern),
    ),
    [savedPermissions],
  );
  const rememberedPermissions = useMemo(
    () => savedPermissions.filter((rule) => !alwaysAllowedApps.includes(rule)),
    [alwaysAllowedApps, savedPermissions],
  );

  const loadComputerStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(false);
    try {
      const response = await apiFetch(API.COMPUTER_CONTROL.STATUS);
      if (!response.ok) throw new Error(`Computer status returned ${response.status}`);
      setComputerStatus(await response.json() as ComputerCapabilityStatus);
    } catch {
      setStatusError(true);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadComputerStatus();
  }, [loadComputerStatus]);

  const handleClearAll = () => {
    if (rememberedPermissions.length === 0) return;
    if (window.confirm(t("permissionsClearConfirm"))) {
      rememberedPermissions.forEach((rule) => {
        clearPermissionRule(rule.tool, rule.pattern ?? "*");
      });
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
            <MonitorUp className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor="computer-use-enabled" className="text-sm font-semibold text-[var(--text-primary)]">
              {t("computerUseTitle")}
            </label>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              {t("computerUseDesc")}
            </p>
            <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">
              {t("computerUseSafety")}
            </p>
          </div>
          <Switch
            id="computer-use-enabled"
            checked={computerUseEnabled}
            onCheckedChange={setComputerUseEnabled}
            aria-label={t("computerUseTitle")}
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)]">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("computerSystemAccess")}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              {t("computerSystemAccessDesc")}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadComputerStatus()}
            disabled={statusLoading}
            aria-label={t("computerRefreshStatus")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", statusLoading && "animate-spin")} />
          </Button>
        </div>
        <div className="border-t border-[var(--border-default)] px-4 py-2">
          {statusLoading && !computerStatus ? (
            <div className="flex items-center gap-2 py-3 text-xs text-[var(--text-secondary)]">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              {t("computerCheckingAccess")}
            </div>
          ) : statusError || !computerStatus ? (
            <div className="flex items-center gap-2 py-3 text-xs text-[var(--color-warning)]">
              <CircleAlert className="h-3.5 w-3.5" />
              {t("computerStatusUnavailable")}
            </div>
          ) : (
            <>
              {computerStatus.platform === "macos" && (
                <>
                  <AccessRow
                    label={t("computerAccessibility")}
                    state={computerStatus.accessibility}
                    grantedLabel={t("computerAccessGranted")}
                    deniedLabel={t("computerAccessNeeded")}
                    unknownLabel={t("computerAccessUnknown")}
                  />
                  <div className="border-t border-[var(--border-default)]" />
                  <AccessRow
                    label={t("computerScreenRecording")}
                    state={computerStatus.screen_recording}
                    grantedLabel={t("computerAccessGranted")}
                    deniedLabel={t("computerAccessNeeded")}
                    unknownLabel={t("computerAccessUnknown")}
                  />
                  <p className="border-t border-[var(--border-default)] py-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                    {t("computerMacBackground")}
                  </p>
                </>
              )}
              {computerStatus.platform === "windows" && (
                <p className="py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  {t("computerWindowsForeground")}
                </p>
              )}
              {!computerStatus.supported && (
                <p className="py-2 text-xs text-[var(--color-warning)]">
                  {t("computerUnsupported")}
                </p>
              )}
              {computerStatus.runtime === "missing" && (
                <p className="border-t border-[var(--border-default)] py-2 text-xs text-[var(--color-warning)]">
                  {t("computerRuntimeMissing")}
                </p>
              )}
              {IS_DESKTOP && computerStatus.settings_url && (
                <Button
                  variant="outline"
                  size="sm"
                  className="my-2"
                  onClick={() => void desktopAPI.openExternal(computerStatus.settings_url!)}
                >
                  {t("computerOpenSystemSettings")}
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              )}
            </>
          )}
        </div>
      </section>

      <section>
        <div>
          <h2 className="text-ui-title-sm font-semibold text-[var(--text-primary)]">
            {t("computerAlwaysAllowedApps")}
          </h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {t("computerAlwaysAllowedAppsDesc")}
          </p>
        </div>
        {alwaysAllowedApps.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-[var(--border-default)] px-4 py-5 text-center">
            <AppWindow className="mx-auto h-5 w-5 text-[var(--text-tertiary)]" />
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              {t("computerAlwaysAllowedAppsEmpty")}
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border-default)]">
            {alwaysAllowedApps.map((rule, index) => (
              <div
                key={`${rule.pattern}-${rule.timestamp}`}
                className={cn(
                  "flex items-center gap-3 px-4 py-3",
                  index > 0 && "border-t border-[var(--border-default)]",
                )}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
                  <AppWindow className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--text-primary)]" title={rule.pattern}>
                    {rule.pattern}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                    {t("computerAlwaysAllowed")}
                    {formatTime(rule.timestamp) ? ` · ${formatTime(rule.timestamp)}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => clearPermissionRule("computer", rule.pattern)}
                  aria-label={t("computerRemoveAllowedApp", { app: rule.pattern })}
                  className="text-[var(--text-secondary)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
            <Globe2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor="browser-use-enabled" className="text-sm font-semibold text-[var(--text-primary)]">
              {t("browserUseTitle")}
            </label>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              {t("browserUseDesc")}
            </p>
            <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">
              {t("browserUseSafety")}
            </p>
          </div>
          <Switch
            id="browser-use-enabled"
            checked={browserUseEnabled}
            onCheckedChange={setBrowserUseEnabled}
            aria-label={t("browserUseTitle")}
          />
        </div>
      </section>

      <section>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-ui-title-sm font-semibold text-[var(--text-primary)]">
              {t("permissionsRemembered")}
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              {t("permissionsDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearAll}
            disabled={rememberedPermissions.length === 0}
            className="shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("permissionsClearAll")}
          </Button>
        </div>
      </section>

      {rememberedPermissions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] px-4 py-8 text-center">
          <ShieldCheck className="mx-auto h-5 w-5 text-[var(--text-tertiary)]" />
          <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
            {t("permissionsEmpty")}
          </p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {t("permissionsEmptyDesc")}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--border-default)]">
          {rememberedPermissions.map((rule, index) => {
            const Icon = rule.allow ? ShieldCheck : ShieldX;
            return (
              <div
                key={`${rule.tool}-${rule.pattern ?? "*"}-${rule.timestamp}`}
                className={cn(
                  "flex items-center gap-3 px-4 py-3",
                  index > 0 && "border-t border-[var(--border-default)]",
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                    rule.allow
                      ? "bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]"
                      : "bg-[var(--color-destructive)]/10 text-[var(--color-destructive)]",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      {ruleLabel(rule)}
                    </p>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        rule.allow
                          ? "bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]"
                          : "bg-[var(--color-destructive)]/10 text-[var(--color-destructive)]",
                      )}
                    >
                      {rule.allow ? t("permissionsAllow") : t("permissionsDeny")}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">
                    {(rule.pattern ?? "*") === "*" ? (
                      t("permissionsScopeAll", { tool: rule.tool })
                    ) : (
                      <span className="font-mono" title={rule.pattern}>
                        {rule.pattern}
                      </span>
                    )}
                    {formatTime(rule.timestamp) ? ` · ${formatTime(rule.timestamp)}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => clearPermissionRule(rule.tool, rule.pattern ?? "*")}
                  title={t("permissionsRevoke")}
                  aria-label={t("permissionsRevokeRule", { tool: rule.tool })}
                  className="shrink-0 text-[var(--text-secondary)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
