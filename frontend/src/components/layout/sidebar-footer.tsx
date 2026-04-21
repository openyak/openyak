"use client";

import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import Link from "next/link";

export function SidebarFooter() {
  const { t } = useTranslation("common");

  return (
    <div className="px-3 py-2">
      <Link
        href="/settings"
        className="flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
      >
        <Settings className="h-[13px] w-[13px] shrink-0" />
        <span>{t("settings")}</span>
      </Link>
    </div>
  );
}
