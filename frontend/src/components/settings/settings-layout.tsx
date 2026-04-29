"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GeneralTab } from "@/components/settings/general-tab";
import { ProvidersTab } from "@/components/settings/providers-tab";
import { BillingTab } from "@/components/settings/billing-tab";
import { UsageSkeleton } from "@/components/settings/usage-tab";
import { MemoryTab } from "@/components/settings/memory-tab";
import { PermissionsTab } from "@/components/settings/permissions-tab";
import { AutomationsTabContent } from "@/app/(main)/automations/content";
import { PluginsTabContent } from "@/app/(main)/plugins/content";
import { RemoteTabContent } from "@/app/(main)/remote/content";
import { SETTINGS_TABS, type SettingsTabId } from "./settings-tabs";

const UsageTab = dynamic(
  () => import("@/components/settings/usage-tab").then((mod) => ({ default: mod.UsageTab })),
  { ssr: false, loading: () => <UsageSkeleton /> },
);

interface SettingsPageClientProps {
  initialTab?: SettingsTabId;
}

const SETTINGS_TAB_IDS = new Set<string>(SETTINGS_TABS.map((tab) => tab.id));

function toSettingsTabId(value: string | null | undefined): SettingsTabId {
  return SETTINGS_TAB_IDS.has(value ?? "") ? (value as SettingsTabId) : "general";
}

export default function SettingsPageClient({ initialTab }: SettingsPageClientProps) {
  const { t } = useTranslation(["settings", "billing", "usage"]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTab = initialTab ?? toSettingsTabId(searchParams.get("tab"));
  const [activeTab, setActiveTab] = useState<SettingsTabId>(selectedTab);

  useEffect(() => {
    setActiveTab(selectedTab);
  }, [selectedTab]);

  const navigateTab = useCallback(
    (tab: string) => {
      setActiveTab(tab as SettingsTabId);
      router.replace(`/settings?tab=${tab}`, { scroll: false });
    },
    [router],
  );

  const activeLabel = t(
    `settings:${SETTINGS_TABS.find((x) => x.id === activeTab)?.labelKey ?? "tabGeneral"}`,
  );

  return (
    <div className="flex-1 overflow-y-auto scrollbar-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 lg:py-10">
        {/* Header — mobile back button + current section title */}
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" asChild>
            <Link href="/c/new">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-ui-xl font-semibold text-[var(--text-primary)]">
            {activeLabel}
          </h1>
        </div>

        {/* Mobile tab pills — desktop uses the SettingsSidebar instead */}
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

        {/* Tab content */}
        <div className="min-w-0">
          {activeTab === "general" && <GeneralTab />}
          {activeTab === "providers" && <ProvidersTab onNavigateTab={navigateTab} />}
          {activeTab === "permissions" && <PermissionsTab />}
          {activeTab === "automations" && <AutomationsTabContent />}
          {activeTab === "plugins" && <PluginsTabContent />}
          {activeTab === "remote" && <RemoteTabContent />}
          {activeTab === "billing" && <BillingTab onNavigateTab={navigateTab} />}
          {activeTab === "usage" && <UsageTab />}
          {activeTab === "memory" && <MemoryTab />}
        </div>
      </div>
    </div>
  );
}
