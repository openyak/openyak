"use client";

import { WORKSPACE_PANEL_WIDTH, IS_DESKTOP, TITLE_BAR_HEIGHT } from "@/lib/constants";
import { ProgressCard } from "./progress-section";
import { FilesCard } from "./files-section";
import { ContextCard } from "./context-section";

export function WorkspacePanel() {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex flex-col bg-[var(--surface-primary)] border-l border-[var(--border-default)] overflow-hidden"
      style={{
        width: WORKSPACE_PANEL_WIDTH,
        ...(IS_DESKTOP ? { top: TITLE_BAR_HEIGHT } : {}),
      }}
    >
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <ProgressCard />
        <FilesCard />
        <ContextCard />
      </div>
    </aside>
  );
}
