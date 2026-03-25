"use client";

import { useRef } from "react";
import { WORKSPACE_PANEL_WIDTH, IS_DESKTOP, TITLE_BAR_HEIGHT } from "@/lib/constants";
import { useScrollbarActivity } from "@/hooks/use-scrollbar-activity";
import { ProgressCard } from "./progress-section";
import { FilesCard } from "./files-section";
import { ContextCard } from "./context-section";

export function WorkspacePanel() {
  const scrollRef = useRef<HTMLDivElement>(null);

  useScrollbarActivity(scrollRef);

  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex flex-col bg-[var(--surface-primary)] border-l border-[var(--border-default)] overflow-hidden"
      style={{
        width: WORKSPACE_PANEL_WIDTH,
        ...(IS_DESKTOP ? { top: TITLE_BAR_HEIGHT } : {}),
      }}
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3 scrollbar-auto">
        <ProgressCard />
        <FilesCard />
        <ContextCard />
      </div>
    </aside>
  );
}
