"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Activity, ChevronDown, FolderOpen, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  IS_DESKTOP,
  TITLE_BAR_HEIGHT,
  WORKSPACE_PANEL_WIDTH,
} from "@/lib/constants";
import { useIsMacOS } from "@/hooks/use-platform";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useMessages } from "@/hooks/use-messages";
import { useSession } from "@/hooks/use-sessions";
import { useSubagents } from "@/hooks/use-subagents";
import { usePlanReviewStore } from "@/stores/plan-review-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { useActivityStore } from "@/stores/activity-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useChatSession, useChatStore } from "@/stores/chat-store";
import {
  useTaskPanelStore,
  type TaskPanelSection,
} from "@/stores/task-panel-store";
import { PlanReviewContent } from "@/components/plan-review/plan-review-panel";
import { ArtifactPanelHeader } from "@/components/artifacts/artifact-panel-header";
import { ArtifactPanelContent } from "@/components/artifacts/artifact-panel-content";
import { ActivityPanelContent } from "@/components/activity/activity-panel";
import { ProgressCard } from "@/components/workspace/progress-section";
import { FilesCard } from "@/components/workspace/files-section";
import { ContextCard } from "@/components/workspace/context-section";
import {
  InputsSection,
  SourcesSection,
} from "@/components/workspace/evidence-sections";
import { SubagentsSummaryCard } from "@/components/workspace/subagents-summary-card";
import {
  collectTaskSummaryEvidence,
  collectTaskSummaryOutputs,
} from "@/components/workspace/workspace-summary-data";
import { cn } from "@/lib/utils";

function halfViewport(): number {
  if (typeof window === "undefined") return 520;
  return Math.max(Math.floor(window.innerWidth / 2), 480);
}

/**
 * The panel's effective width for the current content. A pending plan review
 * forces at least half the viewport so the plan is actually reviewable —
 * everything else uses the user-resized width.
 */
export function useTaskPanelWidth(): number {
  const width = useTaskPanelStore((s) => s.width);
  const planIsOpen = usePlanReviewStore((s) => s.isOpen);
  const artifactIsOpen = useArtifactStore((s) => s.isOpen);
  const activityIsOpen = useActivityStore((s) => s.isOpen);
  const workspaceIsOpen = useWorkspaceStore((s) => s.isOpen);
  const [viewportHalf, setViewportHalf] = useState(halfViewport);
  useEffect(() => {
    const handler = () => setViewportHalf(halfViewport());
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  if (planIsOpen) return Math.max(width, viewportHalf);
  if (workspaceIsOpen && !artifactIsOpen && !activityIsOpen) {
    return WORKSPACE_PANEL_WIDTH;
  }
  return width;
}

/** Whether the unified task panel has anything to show. */
export function useTaskPanelOpen(isActiveChat: boolean): boolean {
  const planIsOpen = usePlanReviewStore((s) => s.isOpen);
  const artifactIsOpen = useArtifactStore((s) => s.isOpen);
  const activityIsOpen = useActivityStore((s) => s.isOpen);
  const workspaceIsOpen = useWorkspaceStore((s) => s.isOpen);
  return (
    planIsOpen ||
    artifactIsOpen ||
    activityIsOpen ||
    (isActiveChat && workspaceIsOpen)
  );
}

function ResizeHandle() {
  const setWidth = useTaskPanelStore((s) => s.setWidth);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = useTaskPanelStore.getState().width;
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMouseMove = (e: MouseEvent) => {
      // Panel is on the right, so dragging left = wider
      setWidth(startWidthRef.current + (startXRef.current - e.clientX));
    };
    const onMouseUp = () => setIsDragging(false);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging, setWidth]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 group hover:bg-[var(--brand-primary)]/20 transition-colors"
    >
      <div className="absolute left-0 top-0 bottom-0 w-[3px] opacity-0 group-hover:opacity-100 bg-[var(--brand-primary)]/40 transition-opacity" />
    </div>
  );
}

function SectionHeader({
  section,
  icon,
  title,
  collapsible = true,
}: {
  section: TaskPanelSection;
  icon: React.ReactNode;
  title: string;
  collapsible?: boolean;
}) {
  const collapsed = useTaskPanelStore((s) => s.collapsed[section] ?? false);
  const toggleSection = useTaskPanelStore((s) => s.toggleSection);
  const expanded = collapsible ? !collapsed : true;
  return (
    <button
      type="button"
      onClick={collapsible ? () => toggleSection(section) : undefined}
      aria-expanded={expanded}
      disabled={!collapsible}
      className={cn(
        "flex w-full shrink-0 items-center gap-2 border-b border-[var(--border-default)] bg-[var(--surface-secondary)]/60 px-3 py-1.5 text-left",
        collapsible && "hover:bg-[var(--surface-secondary)]",
      )}
    >
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {title}
      </span>
      {collapsible && (
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-[var(--text-tertiary)] transition-transform",
            !expanded && "-rotate-90",
          )}
        />
      )}
    </button>
  );
}

function WorkspaceSummaryContent() {
  const parentSessionId = useChatStore((state) => state.focusedSessionId);
  const { messages } = useMessages(parentSessionId ?? undefined);
  const {
    streamingParts,
    pendingAttachments,
    isGenerating,
    isStopped,
  } = useChatSession(parentSessionId);
  const parentFiles = useWorkspaceStore((state) => state.workspaceFiles);
  const { data: parentSession } = useSession(parentSessionId ?? undefined);
  const { data: subagents } = useSubagents(parentSessionId);
  const parentEvidence = useMemo(() => {
    const firstRun = subagents?.active[0] ?? subagents?.done[0];
    const agent =
      [...messages]
        .reverse()
        .find((message) => message.data.agent)?.data.agent ?? "primary";
    return {
      sessionId: parentSessionId ?? "parent",
      agentTitle:
        parentSession?.title || firstRun?.parent_title || "Parent task",
      agent,
      status: isGenerating
        ? ("running" as const)
        : isStopped
          ? ("cancelled" as const)
          : ("completed" as const),
    };
  }, [
    isGenerating,
    isStopped,
    messages,
    parentSession?.title,
    parentSessionId,
    subagents,
  ]);
  const evidence = useMemo(
    () =>
      collectTaskSummaryEvidence(
        messages,
        streamingParts,
        pendingAttachments ?? [],
        subagents,
        parentEvidence,
      ),
    [
      messages,
      parentEvidence,
      pendingAttachments,
      streamingParts,
      subagents,
    ],
  );
  const outputs = useMemo(
    () => collectTaskSummaryOutputs(parentFiles, subagents, parentEvidence),
    [parentEvidence, parentFiles, subagents],
  );

  return (
    <div className="overflow-hidden rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-sm)]">
      <ProgressCard />
      <FilesCard files={outputs} />
      {parentSessionId ? (
        <SubagentsSummaryCard parentSessionId={parentSessionId} />
      ) : null}
      <SourcesSection sources={evidence.sources} />
      <InputsSection inputs={evidence.inputs} />
      <ContextCard />
    </div>
  );
}

/**
 * Unified right-hand task panel (desktop only). Stacks what used to be four
 * mutually-exclusive overlays as sections: pending plan review (pinned,
 * non-collapsible — it gates the conversation), artifact preview, activity
 * timeline, and the workspace progress/files/context cards. Each section's
 * content component is unchanged and only mounts while its store is open and
 * the section is expanded, so lazy renderers stay lazy.
 */
export function TaskPanel({ isActiveChat }: { isActiveChat: boolean }) {
  const { t } = useTranslation("chat");
  const isDesktop = useIsDesktop();
  const isMac = useIsMacOS();
  const planIsOpen = usePlanReviewStore((s) => s.isOpen);
  const artifactIsOpen = useArtifactStore((s) => s.isOpen);
  const activityIsOpen = useActivityStore((s) => s.isOpen);
  const workspaceIsOpen = useWorkspaceStore((s) => s.isOpen);
  const collapsed = useTaskPanelStore((s) => s.collapsed);
  const width = useTaskPanelWidth();
  const isOpen = useTaskPanelOpen(isActiveChat);

  const topOffset = IS_DESKTOP && !isMac ? TITLE_BAR_HEIGHT : 0;

  if (!isDesktop || !isOpen) return null;

  const showWorkspace = isActiveChat && workspaceIsOpen;
  const workspaceOnly =
    showWorkspace && !planIsOpen && !artifactIsOpen && !activityIsOpen;

  return (
    <motion.aside
      aria-label={workspaceOnly ? "Task summary" : t("taskPanel")}
      className={cn(
        "fixed inset-y-0 right-0 z-[35] flex flex-col overflow-hidden",
        workspaceOnly
          ? "pointer-events-none bg-transparent"
          : "border-l border-[var(--border-default)] bg-[var(--surface-primary)]",
      )}
      style={{ width, top: topOffset, ["--panel-right-w" as string]: `${width}px` }}
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", damping: 30, stiffness: 300 }}
    >
      {!workspaceOnly && <ResizeHandle />}

      {/* Pending plan review gates the conversation — pinned, always expanded,
          visually urgent. */}
      {planIsOpen && (
        <section
          aria-label={t("planReadyForReview")}
          className="flex min-h-0 flex-1 flex-col border-b-2 border-[var(--color-warning)]/50"
        >
          <PlanReviewContent />
        </section>
      )}

      {artifactIsOpen && (
        <section className="flex min-h-0 flex-1 flex-col">
          <SectionHeader
            section="artifact"
            icon={<Layers className="h-3.5 w-3.5" />}
            title={t("taskPanelArtifacts")}
          />
          {!collapsed.artifact && (
            <div className="flex min-h-0 flex-1 flex-col">
              <ArtifactPanelHeader />
              <div className="flex-1 overflow-hidden">
                <ArtifactPanelContent />
              </div>
            </div>
          )}
        </section>
      )}

      {activityIsOpen && (
        <section className="flex min-h-0 flex-1 flex-col">
          <SectionHeader
            section="activity"
            icon={<Activity className="h-3.5 w-3.5" />}
            title={t("taskPanelActivity")}
          />
          {!collapsed.activity && (
            <div className="min-h-0 flex-1 overflow-hidden">
              <ActivityPanelContent />
            </div>
          )}
        </section>
      )}

      {showWorkspace && workspaceOnly && (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="scrollbar-auto min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-16">
            <div className="pointer-events-auto">
              <WorkspaceSummaryContent />
            </div>
          </div>
        </section>
      )}

      {showWorkspace && !workspaceOnly && (
        <section
          className={cn(
            "flex min-h-0 flex-col",
            // Workspace is the baseline section: it takes remaining space when
            // alone, and stays compact when a focused section is open above.
            planIsOpen || artifactIsOpen || activityIsOpen
              ? "max-h-[40%] shrink-0"
              : "flex-1",
          )}
        >
          <SectionHeader
            section="workspace"
            icon={<FolderOpen className="h-3.5 w-3.5" />}
            title={t("taskPanelWorkspace")}
          />
          {!collapsed.workspace && (
            <div className="scrollbar-auto min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
              <WorkspaceSummaryContent />
            </div>
          )}
        </section>
      )}
    </motion.aside>
  );
}
