"use client";

import { X, FileText, Image, FileCode, File as FileIcon, Folder } from "lucide-react";
import type { FileAttachment } from "@/types/chat";
import type { FilePart } from "@/types/message";

interface FileChipProps {
  file: FileAttachment | FilePart;
  /** When provided, shows the X remove button. */
  onRemove?: () => void;
}

/** Compact pill showing attached file with type icon. */
export function FileChip({ file, onRemove }: FileChipProps) {
  const Icon = getFileIcon(file.mime_type, file.name);
  const sizeLabel = formatBytes(file.size);

  return (
    <div className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-tertiary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] max-w-[200px]">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
      <span className="truncate" title={file.name}>
        {file.name}
      </span>
      {sizeLabel && <span className="shrink-0 text-[var(--text-tertiary)]">{sizeLabel}</span>}
      {"source" in file && file.source === "referenced" && (
        <span className="shrink-0 text-[10px] text-[var(--text-tertiary)] opacity-60" title="Referenced from disk">ref</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 ml-0.5 rounded-full p-0.5 hover:bg-[var(--surface-secondary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function getFileIcon(mimeType: string, name: string) {
  if (mimeType === "inode/directory") return Folder;
  if (mimeType.startsWith("image/")) return Image;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const codeExts = new Set([
    "py", "js", "ts", "tsx", "jsx", "json", "yaml", "yml", "toml",
    "html", "css", "scss", "xml", "sql", "sh", "bash", "rs", "go",
    "java", "c", "cpp", "h", "hpp", "rb", "php", "swift", "kt",
  ]);
  if (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml") || codeExts.has(ext))
    return FileCode;
  if (mimeType.includes("pdf") || mimeType.includes("document")) return FileText;
  return FileIcon;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
