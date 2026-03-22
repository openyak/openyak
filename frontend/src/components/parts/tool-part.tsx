"use client";

import { useState, useCallback } from "react";
import {
  ChevronRight,
  FileText,
  Play,
  Search,
  Pencil,
  FolderSearch,
  Globe,
  HelpCircle,
  ListTodo,
  Layers,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  LayoutDashboard,
  FileDiff,
  Plug,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { useArtifactStore } from "@/stores/artifact-store";
import { isPreviewableFile, artifactTypeFromExtension, languageFromExtension } from "@/lib/artifacts";
import type { ToolPart } from "@/types/message";

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read: FileText,
  write: FileText,
  edit: Pencil,
  multiedit: Pencil,
  apply_patch: FileDiff,
  bash: Play,
  glob: FolderSearch,
  grep: Search,
  web_fetch: Globe,
  web_search: Globe,
  question: HelpCircle,
  todo: ListTodo,
  task: Layers,
  artifact: LayoutDashboard,
};

/** Fallback icon for MCP and other unknown tools */
const DEFAULT_TOOL_ICON = Plug;

const STATUS_CONFIG: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; label: string; color: string }
> = {
  pending: {
    icon: Clock,
    label: "Pending",
    color: "text-[var(--tool-pending)]",
  },
  running: {
    icon: Loader2,
    label: "Running",
    color: "text-[var(--text-tertiary)]",
  },
  completed: {
    icon: CheckCircle2,
    label: "Completed",
    color: "text-[var(--tool-completed)]",
  },
  error: {
    icon: XCircle,
    label: "Error",
    color: "text-[var(--tool-error)]",
  },
};

interface ToolPartViewProps {
  data: ToolPart;
}

function getFileName(filePath?: string): string | null {
  if (!filePath) return null;
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

function truncateCmd(cmd: string): string {
  return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
}

function generateToolTitle(data: ToolPart, t: TFunction): string {
  if (data.state.title) return data.state.title;

  const { tool, state } = data;
  const input = state.input as Record<string, string | undefined>;

  switch (tool) {
    case "read":
      return t("toolReading", { name: getFileName(input.file_path) ?? t("file") });
    case "write":
      return t("toolWriting", { name: getFileName(input.file_path) ?? t("file") });
    case "edit":
      return t("toolEditing", { name: getFileName(input.file_path) ?? t("file") });
    case "multiedit":
      return t("toolMultiEditing", { name: getFileName(input.file_path) ?? t("file"), defaultValue: "Multi-editing {{name}}" });
    case "apply_patch":
      return t("toolApplyingPatch", { defaultValue: "Applying patch" });
    case "bash":
      return t("toolRunningCommand");
    case "glob":
      return t("toolSearchingFiles");
    case "grep":
      return t("toolSearching", { query: input.pattern ?? "" });
    case "web_fetch":
      return t("toolFetching", { url: truncateCmd(String(input.url ?? "")) });
    case "web_search":
      return t("toolSearchingWeb", { query: truncateCmd(String(input.query ?? "")) });
    case "task":
      return input.description ?? t("toolWorkingOnSubtask");
    case "question":
      return t("toolAskingQuestion");
    case "todo":
      return t("toolUpdatingProgress");
    case "submit_plan":
      return t("toolSubmittingPlan");
    case "artifact": {
      const meta = (state.metadata ?? {}) as Record<string, string | undefined>;
      const cmd = input.command || meta.command || "create";
      const artifactTitle = input.title || meta.title || "artifact";
      if (cmd === "update") return t("toolUpdated", { name: artifactTitle });
      if (cmd === "rewrite") return t("toolRewrote", { name: artifactTitle });
      return t("toolCreated", { name: artifactTitle });
    }
    default:
      return tool;
  }
}

function formatToolInput(data: ToolPart): string {
  const { tool, state } = data;
  const input = state.input;
  switch (tool) {
    case "bash":
      return String(input.command ?? "");
    case "read":
    case "write":
      return String(input.file_path ?? "");
    case "edit":
      return `File: ${input.file_path ?? ""}\n\nOld: ${input.old_string ?? ""}\n\nNew: ${input.new_string ?? ""}`;
    case "multiedit":
      return `File: ${input.file_path ?? ""}\n\n${JSON.stringify(input.edits, null, 2)}`;
    case "apply_patch":
      return String(input.patch_text ?? "");
    case "grep":
      return `Pattern: ${input.pattern ?? ""}\nPath: ${input.path ?? "."}`;
    case "glob":
      return `Pattern: ${input.pattern ?? ""}`;
    case "web_search":
      return String(input.query ?? "");
    case "web_fetch":
      return String(input.url ?? "");
    default:
      return JSON.stringify(input, null, 2);
  }
}

export function ToolPartView({ data }: ToolPartViewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { t } = useTranslation("chat");
  const openArtifact = useArtifactStore((s) => s.openArtifact);

  const statusConfig = STATUS_CONFIG[data.state.status];
  const StatusIcon = statusConfig.icon;
  const title = generateToolTitle(data, t);
  const isRunning = data.state.status === "running";
  const isError = data.state.status === "error";
  const isCompleted = data.state.status === "completed";

  // Check if this is a previewable write/edit tool
  const input = data.state.input as Record<string, string | undefined>;
  const filePath = input.file_path;
  const canPreview =
    isCompleted &&
    (data.tool === "write" || data.tool === "edit" || data.tool === "multiedit") &&
    filePath &&
    isPreviewableFile(filePath);

  const handlePreview = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!filePath) return;
      const type = artifactTypeFromExtension(filePath) || "code";
      openArtifact({
        id: `file-${data.call_id}`,
        title: getFileName(filePath) || "File Preview",
        type: "file-preview",
        content: data.tool === "write" ? String(input.content ?? "") : "",
        language: languageFromExtension(filePath),
        filePath,
      });
    },
    [filePath, data.call_id, data.tool, input.content, openArtifact],
  );

  // Compute elapsed time
  let elapsed = "";
  if (data.state.time_start && data.state.time_end) {
    const ms =
      new Date(data.state.time_end).getTime() -
      new Date(data.state.time_start).getTime();
    elapsed = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  // Don't render expandable detail for artifact tool (it's shown in the panel)
  if (data.tool === "artifact") {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)] py-1">
        <LayoutDashboard className="h-3.5 w-3.5 text-[var(--tool-completed)]" />
        <span>{title}</span>
        {elapsed && (
          <span className="text-[10px] text-[var(--text-tertiary)]">{elapsed}</span>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Compact trigger — matches reasoning-part style */}
      <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)] py-1">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 hover:text-[var(--text-secondary)] transition-colors"
          aria-label="Expand details"
          aria-expanded={isOpen}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              isOpen && "rotate-90",
            )}
          />
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5",
              statusConfig.color,
              isRunning && "animate-spin",
            )}
          />
          <span className={cn("truncate", isRunning && "shimmer-text")}>{title}</span>
          {elapsed && (
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {elapsed}
            </span>
          )}
        </button>
        {/* Preview button for write/edit tools */}
        {canPreview && (
          <button
            type="button"
            onClick={handlePreview}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-tertiary)] transition-colors"
            aria-label="Preview file"
          >
            <Eye className="h-3 w-3" />
            <span>{t("preview")}</span>
          </button>
        )}
      </div>

      {/* Expandable content with framer-motion */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { type: "spring", stiffness: 400, damping: 35 },
              opacity: { duration: 0.2, delay: 0.05 },
            }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "mt-1 rounded-xl border bg-[var(--surface-secondary)] overflow-hidden",
                isError ? "border-[var(--color-destructive)]/20" : "border-[var(--border-default)]",
              )}
            >
              {/* Details */}
              {Object.keys(data.state.input).length > 0 && (
                <div className="border-b border-[var(--border-default)]">
                  <p className="px-3 py-1.5 text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider bg-[var(--surface-tertiary)]">
                    {t("details")}
                  </p>
                  <pre className="p-3 text-xs text-[var(--text-secondary)] overflow-x-auto font-mono leading-relaxed max-h-[120px] sm:max-h-[200px]">
                    {formatToolInput(data)}
                  </pre>
                </div>
              )}

              {/* Result */}
              {data.state.output && (
                <div>
                  <p
                    className={cn(
                      "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider bg-[var(--surface-tertiary)]",
                      isError ? "text-[var(--tool-error)]" : isCompleted ? "text-[var(--tool-completed)]" : "text-[var(--text-tertiary)]",
                    )}
                  >
                    {t("result")}
                  </p>
                  <div
                    className={cn(
                      "border-l-2 mx-0",
                      isError ? "border-l-[var(--tool-error)]" : isCompleted ? "border-l-[var(--tool-completed)]" : "border-l-transparent",
                    )}
                  >
                    <pre className="p-3 text-xs text-[var(--text-secondary)] overflow-x-auto font-mono leading-relaxed max-h-[200px] sm:max-h-[300px] overflow-y-auto">
                      {data.state.output.length > 5000
                        ? data.state.output.slice(0, 5000) + "\n" + t("truncated")
                        : data.state.output}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
