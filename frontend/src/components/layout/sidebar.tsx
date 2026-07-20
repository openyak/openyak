"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarHeader } from "./sidebar-header";
import { SessionList } from "./session-list";
import { SidebarFooter } from "./sidebar-footer";
import { SearchCommandDialog } from "./search-command-dialog";
import { SidebarResizeHandle } from "./sidebar-resize-handle";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useIsMacOS } from "@/hooks/use-platform";
import { IS_DESKTOP, TITLE_BAR_HEIGHT } from "@/lib/constants";

export function Sidebar() {
  const isCollapsed = useSidebarStore((s) => s.isCollapsed);
  const width = useSidebarStore((s) => s.width);
  const isMac = useIsMacOS();

  // macOS: sidebar extends to the window top (traffic lights overlay the
  // sidebar header). Windows/Linux: sit below the 32px custom title bar.
  const topOffset = IS_DESKTOP && !isMac ? TITLE_BAR_HEIGHT : 0;

  return (
    <TooltipProvider delayDuration={200}>
      <motion.aside
        aria-label="Chat sidebar"
        className="sidebar-glass fixed inset-y-0 left-0 z-30 flex flex-col overflow-hidden bg-[var(--sidebar-translucent-bg)] backdrop-blur-xl"
        style={IS_DESKTOP ? { top: topOffset } : undefined}
        initial={false}
        animate={{ width: isCollapsed ? 0 : width }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
      >
        <SidebarHeader />
        <Suspense fallback={<div className="flex-1" />}>
          <SessionList />
        </Suspense>
        <SidebarFooter />
        {!isCollapsed && <SidebarResizeHandle />}
      </motion.aside>
      <SearchCommandDialog />
    </TooltipProvider>
  );
}
