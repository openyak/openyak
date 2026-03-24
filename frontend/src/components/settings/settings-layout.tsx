"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, Settings, Cpu, CreditCard, BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GeneralTab } from "@/components/settings/general-tab";
import { ProvidersTab } from "@/components/settings/providers-tab";
import { BillingTab } from "@/components/settings/billing-tab";
import { UsageSkeleton } from "@/components/settings/usage-tab";

const UsageTab = dynamic(
  () => import("@/components/settings/usage-tab").then((mod) => ({ default: mod.UsageTab })),
  { ssr: false, loading: () => <UsageSkeleton /> },
);

const SETTINGS_TABS = [
  { id: "general", icon: Settings, labelKey: "tabGeneral" },
  { id: "providers", icon: Cpu, labelKey: "tabProviders" },
  { id: "billing", icon: CreditCard, labelKey: "tabBilling" },
  { id: "usage", icon: BarChart3, labelKey: "tabUsage" },
] as const;

type TabId = (typeof SETTINGS_TABS)[number]["id"];

export default function SettingsPageClient() {
  const { t } = useTranslation(["settings", "billing", "usage"]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = (searchParams.get("tab") as TabId) || "general";

  const navigateTab = useCallback(
    (tab: string) => {
      router.replace(`/settings?tab=${tab}`, { scroll: false });
    },
    [router],
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" asChild>
            <Link href="/c/new">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            {t("settings:title")}
          </h1>
        </div>

        {/* Mobile tab pills */}
        <div className="flex gap-1 overflow-x-auto pb-4 lg:hidden">
          {SETTINGS_TABS.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              onClick={() => navigateTab(id)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition-colors shrink-0",
                activeTab === id
                  ? "bg-[var(--brand-primary)] text-[var(--brand-primary-text)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(`settings:${labelKey}`)}
            </button>
          ))}
        </div>

        {/* Desktop: left nav + content */}
        <div className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-8">
          {/* Left nav (desktop only) */}
          <nav className="hidden lg:block">
            <div className="sticky top-8 space-y-1">
              {SETTINGS_TABS.map(({ id, icon: Icon, labelKey }) => (
                <button
                  key={id}
                  onClick={() => navigateTab(id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-colors",
                    activeTab === id
                      ? "bg-[var(--surface-secondary)] text-[var(--text-primary)] font-medium"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" />
                  {t(`settings:${labelKey}`)}
                </button>
              ))}
            </div>
          </nav>

          {/* Tab content */}
          <div className="min-w-0">
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "providers" && <ProvidersTab onNavigateTab={navigateTab} />}
            {activeTab === "billing" && <BillingTab onNavigateTab={navigateTab} />}
            {activeTab === "usage" && <UsageTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
