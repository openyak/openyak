"use client";

import { useEffect, useId, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { useWorkspaceStore, type WorkspaceFile } from "@/stores/workspace-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { cn } from "@/lib/utils";
import type { EvidenceOrigin } from "@/types/subagent";

const INITIAL_VISIBLE_FILES = 5;

function describeOrigins(origins: EvidenceOrigin[]): string | null {
  if (origins.length === 0) return null;
  return `Origins: ${origins
    .map((origin) =>
      [
        origin.agentTitle,
        `agent ${origin.agent}`,
        `session ${origin.sessionId}`,
        origin.agentRunId ? `run ${origin.agentRunId}` : null,
        origin.status,
        `via ${origin.source}`,
        origin.tool ? `using ${origin.tool}` : "tool unavailable",
      ]
        .filter(Boolean)
        .join(", "),
    )
    .join("; ")}`;
}

function visibleChildOrigin(origins: EvidenceOrigin[]): string | null {
  const childOrigins = origins.filter((origin) => origin.source !== "parent");
  if (childOrigins.length === 0) return null;
  const lead = childOrigins[0];
  return [
    origins.length > 1 ? `${origins.length} origins` : null,
    lead.agentTitle,
    lead.status,
    lead.tool,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

function FileItem({ file }: { file: WorkspaceFile }) {
  const handleClick = () => {
    const store = useArtifactStore.getState();
    // Match by filePath first, then fall back to matching by title (for artifacts
    // created by the artifact tool which don't have filePath set yet)
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const existing = store.artifacts.find(
      (a) => a.filePath === file.path || (!a.filePath && a.title === baseName),
    );
    if (existing) {
      // Re-open with filePath set so future lookups match directly
      store.openArtifact({ ...existing, filePath: file.path });
      return;
    }
    store.openArtifact({
      id: `workspace-${file.path}`,
      type: "file-preview",
      title: file.name,
      content: "",
      filePath: file.path,
    });
  };

  const displayName =
    file.type === "instructions" ? `Instructions \u00b7 ${file.name}` : file.name;
  const origins = file.origins ?? [];
  const visibleProvenance = visibleChildOrigin(origins);
  const lineage = describeOrigins(origins);

  return (
    <button
      className="flex w-full items-center gap-3 px-4 py-1.5 text-left transition-colors hover:bg-[var(--surface-tertiary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
      onClick={handleClick}
      aria-label={lineage ? `${displayName}. ${lineage}` : displayName}
      title={lineage ? `${file.path} — ${lineage}` : file.path}
    >
      <FileText className="size-4 shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-5 text-[var(--text-primary)]">
          {displayName}
        </span>
        {visibleProvenance ? (
          <span className="block truncate text-[11px] leading-4 text-[var(--text-tertiary)]">
            {visibleProvenance}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function Scratchpad() {
  const content = useWorkspaceStore((s) => s.scratchpadContent);
  const setContent = useWorkspaceStore((s) => s.setScratchpadContent);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mx-4 mb-3">
      <button
        className={cn(
          "flex items-center gap-1.5 w-full px-3 py-2 rounded-lg text-left transition-colors",
          "border",
          expanded
            ? "border-[var(--border-focus)] bg-[var(--surface-primary)]"
            : "border-[var(--border-default)] hover:border-[var(--text-tertiary)]",
        )}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-[var(--text-tertiary)]" />
        ) : (
          <ChevronRight className="h-3 w-3 text-[var(--text-tertiary)]" />
        )}
        <span className="text-[13px] text-[var(--text-tertiary)]">
          Scratchpad
        </span>
      </button>
      {expanded && (
        <textarea
          className={cn(
            "w-full mt-1.5 px-3 py-2 text-[13px] leading-relaxed rounded-lg resize-none",
            "bg-[var(--surface-primary)] text-[var(--text-primary)]",
            "placeholder:text-[var(--text-quaternary)]",
            "border border-[var(--border-focus)] focus:outline-none",
            "min-h-[80px]",
          )}
          placeholder="Notes, ideas, reminders..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          autoFocus
        />
      )}
    </div>
  );
}

export function FilesCard({ files }: { files: WorkspaceFile[] }) {
  const workspaceFiles = files;
  const scratchpadContent = useWorkspaceStore((s) => s.scratchpadContent);
  const collapsed = useWorkspaceStore((s) => s.collapsedSections["files"]);
  const toggleSection = useWorkspaceStore((s) => s.toggleSection);
  const expandSection = useWorkspaceStore((s) => s.expandSection);
  const [showAll, setShowAll] = useState(false);
  const filesListId = useId();
  const hasContent = workspaceFiles.length > 0 || scratchpadContent.trim().length > 0;
  const visibleFiles = showAll
    ? workspaceFiles
    : workspaceFiles.slice(0, INITIAL_VISIBLE_FILES);
  const hiddenFileCount = workspaceFiles.length - visibleFiles.length;
  const fileSummary =
    workspaceFiles.length > 0
      ? `${workspaceFiles.length} generated file${workspaceFiles.length === 1 ? "" : "s"}`
      : hasContent
        ? "Notes available"
        : "No files yet";

  // Completed Work Mode tasks surface their deliverables immediately. The
  // effect keys off the count, so a deliberate user collapse remains stable
  // until a genuinely new output arrives.
  useEffect(() => {
    if (workspaceFiles.length > 0) {
      expandSection("files");
    }
  }, [expandSection, workspaceFiles.length]);

  if (!hasContent) return null;

  return (
    <section className="overflow-hidden">
      <button
        className="flex h-12 w-full items-center justify-between px-4 text-left transition-colors hover:bg-[var(--surface-tertiary)]"
        onClick={() => toggleSection("files")}
        aria-expanded={!collapsed}
        aria-controls="workspace-outputs-content"
        aria-label={`Outputs. ${fileSummary}`}
      >
        <h2 className="text-base font-normal text-[var(--text-tertiary)]">
          Outputs
        </h2>
        <ChevronDown
          className={cn(
            "size-4 text-[var(--text-tertiary)] transition-transform duration-200",
            collapsed && "-rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            id="workspace-outputs-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="overflow-hidden"
          >
            <div className="pb-2">
              {workspaceFiles.length > 0 ? (
                <div id={filesListId}>
                  {visibleFiles.map((file) => (
                    <FileItem key={file.path} file={file} />
                  ))}
                </div>
              ) : (
                <p className="px-4 py-1.5 text-[13px] text-[var(--text-quaternary)]">
                  No outputs yet
                </p>
              )}
              {workspaceFiles.length > INITIAL_VISIBLE_FILES && (
                <button
                  type="button"
                  className="mx-4 mt-1 rounded-md py-1 text-[13px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
                  onClick={() => setShowAll((current) => !current)}
                  aria-expanded={showAll}
                  aria-controls={filesListId}
                >
                  {showAll ? "Show less" : `Show ${hiddenFileCount} more`}
                </button>
              )}
              <div className="mt-2 border-t border-[var(--border-subtle)] pt-3">
                <Scratchpad />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
