"use client";

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Pencil, Download, Check, X, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  useWorkspaceMemoryList,
  useUpdateWorkspaceMemory,
  useDeleteWorkspaceMemory,
  useExportWorkspaceMemory,
} from "@/hooks/use-workspace-memory";
import type { WorkspaceMemoryListItem } from "@/types/workspace-memory";

// ── Workspace Memory Item ────────────────────────────────

function WorkspaceMemoryItem({
  item,
  onDeleted,
}: {
  item: WorkspaceMemoryListItem;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("settings");
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const updateMutation = useUpdateWorkspaceMemory();
  const deleteMutation = useDeleteWorkspaceMemory();
  const exportMutation = useExportWorkspaceMemory();

  const handleEdit = () => {
    setDraft(item.content);
    setEditing(true);
    setExpanded(true);
  };

  const handleSave = () => {
    updateMutation.mutate(
      { workspace_path: item.workspace_path, content: draft },
      {
        onSuccess: () => {
          toast.success(t("memorySaved"));
          setEditing(false);
        },
        onError: () => toast.error("Failed to save"),
      },
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(item.workspace_path, {
      onSuccess: () => {
        toast.success(t("memoryDeleted"));
        setDeleteDialogOpen(false);
        onDeleted();
      },
    });
  };

  const handleExport = () => {
    exportMutation.mutate(item.workspace_path, {
      onSuccess: (res) => toast.success(t("memoryExported", { path: res.exported_to })),
      onError: () => toast.error("Failed to export"),
    });
  };

  // Display last part of workspace path for readability
  const displayPath = item.workspace_path.split("/").slice(-2).join("/");
  const lastUpdated = item.time_updated
    ? new Date(item.time_updated).toLocaleDateString()
    : null;

  return (
    <>
      <div className="rounded-xl border border-[var(--border-default)] p-4 transition-colors hover:border-[var(--border-hover,var(--border-default))]">
        {/* Header row */}
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent-primary)] transition-colors min-w-0"
          >
            <FolderOpen className="h-4 w-4 text-[var(--text-secondary)] shrink-0" />
            <span className="truncate" title={item.workspace_path}>
              {displayPath}
            </span>
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[11px] text-[var(--text-quaternary)] mr-2">
              {t("memoryLines", { count: item.line_count })}
              {lastUpdated && ` \u00b7 ${lastUpdated}`}
            </span>
            {!editing && (
              <>
                <button
                  onClick={handleEdit}
                  className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
                  title={t("memoryEdit")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={handleExport}
                  disabled={exportMutation.isPending}
                  className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors disabled:opacity-50"
                  title={t("memoryExport")}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setDeleteDialogOpen(true)}
                  className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10 transition-colors"
                  title={t("memoryDelete")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Full path */}
        <p className="text-[11px] text-[var(--text-quaternary)] mb-2 truncate" title={item.workspace_path}>
          {item.workspace_path}
        </p>

        {/* Content area */}
        {expanded && (
          editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full min-h-[160px] max-h-[400px] rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] px-3 py-2 text-[12px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:ring-1 focus:ring-[var(--ring)] resize-y"
                placeholder="Workspace memory (Markdown)..."
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(false)}
                  className="gap-1"
                >
                  <X className="h-3 w-3" />
                  {t("memoryCancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="gap-1"
                >
                  <Check className="h-3 w-3" />
                  {t("memorySave")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="max-h-[300px] overflow-y-auto scrollbar-auto">
              <pre className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono leading-relaxed">
                {item.content || "(empty)"}
              </pre>
            </div>
          )
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("memoryDeleteConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("memoryDeleteConfirmDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleteDialogOpen(false)}>
              {t("memoryCancel")}
            </Button>
            <Button
              size="sm"
              className="bg-[var(--color-destructive)] text-white hover:bg-[var(--color-destructive)]/90"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {t("memoryDeleteConfirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Main Memory Tab ───────────────────────────────────────

export function MemoryTab() {
  const { t } = useTranslation("settings");
  const { data: memories, isLoading, error, refetch } = useWorkspaceMemoryList();

  const handleDeleted = useCallback(() => {
    refetch();
  }, [refetch]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-64" />
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-4">
        <p className="text-sm text-[var(--color-destructive)]">
          Failed to load workspace memories:{" "}
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  const items = memories ?? [];

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-secondary)]">{t("memoryDesc")}</p>

      {items.length === 0 ? (
        <p className="text-sm text-[var(--text-tertiary)] py-8 text-center">
          {t("memoryEmpty")}
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <WorkspaceMemoryItem
              key={item.workspace_path}
              item={item}
              onDeleted={handleDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}
