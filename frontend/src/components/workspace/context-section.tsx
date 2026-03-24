"use client";

import { ChevronDown, Plug, Zap } from "lucide-react";
import { useConnectors } from "@/hooks/use-connectors";
import { useSkills } from "@/hooks/use-plugins";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

const STATUS_DOT: Record<string, string> = {
  connected: "bg-green-500",
  needs_auth: "bg-yellow-500",
  failed: "bg-red-500",
};

function ConnectorsBlock() {
  const { data, isLoading } = useConnectors();
  const connectors = data?.connectors ? Object.values(data.connectors) : [];
  // Only show connectors that are actually connected (not just enabled)
  const connected = connectors.filter((c) => c.status === "connected");

  if (isLoading) {
    return (
      <div className="px-4 py-2">
        <div className="h-4 w-24 rounded bg-[var(--surface-tertiary)] animate-pulse" />
      </div>
    );
  }

  return (
    <div className="mb-1">
      <p className="px-4 py-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">
        Connectors
      </p>
      {connected.length === 0 ? (
        <p className="px-4 py-1 text-[12px] text-[var(--text-quaternary)]">
          No connectors active
        </p>
      ) : (
        <div className="space-y-0.5">
          {connected.map((connector) => (
            <div
              key={connector.id}
              className="flex items-center gap-2.5 px-4 py-1.5"
            >
              <div
                className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  STATUS_DOT[connector.status] ?? "bg-[var(--text-quaternary)]",
                )}
              />
              <Plug className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
              <span className="text-[13px] text-[var(--text-secondary)] truncate">
                {connector.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillsSummary() {
  const { data: skills, isLoading } = useSkills();

  if (isLoading) return null;
  if (!skills || skills.length === 0) return null;

  return (
    <div>
      <p className="px-4 py-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">
        Skills
      </p>
      <div className="px-4 py-1">
        <span className="text-[13px] text-[var(--text-secondary)]">
          {skills.length} skills available
        </span>
      </div>
    </div>
  );
}

export function ContextCard() {
  const collapsed = useWorkspaceStore((s) => s.collapsedSections["context"]);
  const toggleSection = useWorkspaceStore((s) => s.toggleSection);

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] overflow-hidden">
      <button
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-[var(--surface-tertiary)]/50 transition-colors"
        onClick={() => toggleSection("context")}
      >
        <span className="text-sm font-medium text-[var(--text-primary)]">
          Context
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-[var(--text-tertiary)] transition-transform duration-200",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {!collapsed && (
        <div className="pb-3">
          <ConnectorsBlock />
          <SkillsSummary />
        </div>
      )}
    </div>
  );
}
