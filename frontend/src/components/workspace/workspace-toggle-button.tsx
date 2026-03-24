"use client";

import { PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function WorkspaceToggleButton() {
  const toggle = useWorkspaceStore((s) => s.toggle);
  const isOpen = useWorkspaceStore((s) => s.isOpen);
  const todos = useWorkspaceStore((s) => s.todos);
  const hasActiveTodos = todos.some((t) => t.status === "in_progress");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 relative"
          onClick={toggle}
          aria-label="Toggle workspace"
          data-state={isOpen ? "active" : undefined}
        >
          <PanelRight className="h-[18px] w-[18px]" />
          {hasActiveTodos && (
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-[var(--text-accent)] animate-pulse" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Workspace</TooltipContent>
    </Tooltip>
  );
}
