"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarHeader } from "./sidebar-header";
import { SessionList } from "./session-list";
import { SidebarFooter } from "./sidebar-footer";
import { SearchCommandDialog } from "./search-command-dialog";
import { useSidebarStore } from "@/stores/sidebar-store";
import { SIDEBAR_WIDTH, IS_DESKTOP, TITLE_BAR_HEIGHT } from "@/lib/constants";

const SidebarNav = dynamic(
  () => import("./sidebar-nav").then((mod) => mod.SidebarNav),
  {
    ssr: false,
    loading: () => <div className="px-3 pt-1 pb-2" aria-hidden="true" />,
  },
);

export function Sidebar() {
  const isCollapsed = useSidebarStore((s) => s.isCollapsed);

  return (
    <TooltipProvider delayDuration={200}>
      <motion.aside
        aria-label="Chat sidebar"
        className="fixed inset-y-0 left-0 z-30 flex flex-col overflow-hidden bg-[var(--sidebar-bg)]/98 backdrop-blur-sm"
        style={IS_DESKTOP ? { top: TITLE_BAR_HEIGHT } : undefined}
        initial={false}
        animate={{ width: isCollapsed ? 0 : SIDEBAR_WIDTH }}
        transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
      >
        <SidebarHeader />
        <SidebarNav />
        <Suspense fallback={<div className="flex-1" />}>
          <SessionList />
        </Suspense>
        <SidebarFooter />
      </motion.aside>
      <SearchCommandDialog />
    </TooltipProvider>
  );
}
