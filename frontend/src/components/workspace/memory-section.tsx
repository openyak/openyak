"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Brain, Pencil, Check, X, Download } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useWorkspaceMemory,
  useUpdateWorkspaceMemory,
  useExportWorkspaceMemory,
} from "@/hooks/use-workspace-memory";
import { cn } from "@/lib/utils";

export function MemoryCard() {
  const collapsed = useWorkspaceStore((s) => s.collapsedSections["memory"]);
  const toggleSection = useWorkspaceStore((s) => s.toggleSection);
  const workspacePath = useSettingsStore((s) => s.workspaceDirectory);

  const { data, isLoading } = useWorkspaceMemory(workspacePath);
  const updateMutation = useUpdateWorkspaceMemory();
  const exportMutation = useExportWorkspaceMemory();

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");

  const content = data?.content ?? "";

  const handleStartEdit = useCallback(() => {
    setEditContent(content);
    setIsEditing(true);
  }, [content]);

  const handleSave = useCallback(() => {
    if (!workspacePath) return;
    updateMutation.mutate(
      { workspace_path: workspacePath, content: editContent },
      {
        onSuccess: () => {
          setIsEditing(false);
          toast.success("Memory saved");
        },
        onError: () => toast.error("Failed to save memory"),
      },
    );
  }, [workspacePath, editContent, updateMutation]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditContent("");
  }, []);

  const handleExport = useCallback(() => {
    if (!workspacePath) return;
    exportMutation.mutate(workspacePath, {
      onSuccess: (res) => toast.success(`Exported to ${res.exported_to}`),
      onError: () => toast.error("Failed to export memory"),
    });
  }, [workspacePath, exportMutation]);

  // Don't render if no workspace is selected
  if (!workspacePath) return null;

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] overflow-hidden">
      <button
        className="flex items-center justify-between w-full px-4 py-3 text-left transition-colors"
        onClick={() => toggleSection("memory")}
      >
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-[var(--text-tertiary)]" />
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Memory
          </span>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-[var(--text-tertiary)] transition-transform duration-200",
            collapsed && "-rotate-90",
          )}
        />
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
            <div className="px-4 pb-3">
              {/* Action buttons */}
              <div className="flex items-center gap-1.5 mb-2">
                {isEditing ? (
                  <>
                    <button
                      onClick={handleSave}
                      disabled={updateMutation.isPending}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-[var(--accent-primary)] text-white hover:opacity-90 disabled:opacity-50"
                    >
                      <Check className="h-3 w-3" />
                      Save
                    </button>
                    <button
                      onClick={handleCancel}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-tertiary)]"
                    >
                      <X className="h-3 w-3" />
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleStartEdit}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-tertiary)]"
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </button>
                    {content && (
                      <button
                        onClick={handleExport}
                        disabled={exportMutation.isPending}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-tertiary)] disabled:opacity-50"
                      >
                        <Download className="h-3 w-3" />
                        Export
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Content area */}
              {isEditing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full min-h-[120px] max-h-[300px] p-2 text-[12px] font-mono rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--text-primary)] resize-y focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
                  placeholder="Workspace memory (Markdown)..."
                />
              ) : isLoading ? (
                <div className="space-y-1.5">
                  <div className="h-3 w-3/4 rounded bg-[var(--surface-tertiary)] animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-[var(--surface-tertiary)] animate-pulse" />
                </div>
              ) : content ? (
                <div className="max-h-[200px] overflow-y-auto scrollbar-auto">
                  <pre className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {content}
                  </pre>
                </div>
              ) : (
                <p className="text-[12px] text-[var(--text-quaternary)]">
                  No memory yet. It will be generated automatically after
                  conversations.
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
