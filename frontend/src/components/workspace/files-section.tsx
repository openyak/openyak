"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronRight, FileText, FolderOpen } from "lucide-react";
import { useWorkspaceStore, type WorkspaceFile } from "@/stores/workspace-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { cn } from "@/lib/utils";

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

  return (
    <button
      className="w-full flex items-center gap-2.5 px-4 py-1.5 text-left transition-colors"
      onClick={handleClick}
    >
      <FileText className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
      <span className="text-[13px] text-[var(--text-secondary)] truncate">
        {displayName}
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

export function FilesCard() {
  const workspaceFiles = useWorkspaceStore((s) => s.workspaceFiles);
  const collapsed = useWorkspaceStore((s) => s.collapsedSections["files"]);
  const toggleSection = useWorkspaceStore((s) => s.toggleSection);

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] overflow-hidden">
      <button
        className="flex items-center justify-between w-full px-4 py-3 text-left transition-colors"
        onClick={() => toggleSection("files")}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Files
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <FolderOpen className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          <ChevronDown
            className={cn(
              "h-4 w-4 text-[var(--text-tertiary)] transition-transform duration-200",
              collapsed && "-rotate-90",
            )}
          />
        </div>
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="overflow-hidden"
          >
            <div className="pb-1">
              {workspaceFiles.length > 0 ? (
                <div className="space-y-0.5">
                  {workspaceFiles.map((file) => (
                    <FileItem key={file.path} file={file} />
                  ))}
                </div>
              ) : (
                <p className="px-4 py-2 text-[12px] text-[var(--text-quaternary)]">
                  No files yet
                </p>
              )}
              <div className="mt-2">
                <Scratchpad />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
