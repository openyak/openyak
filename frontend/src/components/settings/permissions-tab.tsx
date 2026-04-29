"use client";

import { ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useSettingsStore, type SavedPermissionRule } from "@/stores/settings-store";
import { cn } from "@/lib/utils";

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

export function PermissionsTab() {
  const { t } = useTranslation("settings");
  const savedPermissions = useSettingsStore((s) => s.savedPermissions);
  const clearPermissionRule = useSettingsStore((s) => s.clearPermissionRule);
  const clearAllPermissionRules = useSettingsStore((s) => s.clearAllPermissionRules);

  const handleClearAll = () => {
    if (savedPermissions.length === 0) return;
    if (window.confirm(t("permissionsClearConfirm"))) {
      clearAllPermissionRules();
    }
  };

  return (
    <div className="space-y-6">
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
            disabled={savedPermissions.length === 0}
            className="shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("permissionsClearAll")}
          </Button>
        </div>
      </section>

      {savedPermissions.length === 0 ? (
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
          {savedPermissions.map((rule, index) => {
            const Icon = rule.allow ? ShieldCheck : ShieldX;
            return (
              <div
                key={`${rule.tool}-${rule.timestamp}`}
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
                    {t("permissionsScopeAll", { tool: rule.tool })}
                    {formatTime(rule.timestamp) ? ` · ${formatTime(rule.timestamp)}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => clearPermissionRule(rule.tool)}
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
