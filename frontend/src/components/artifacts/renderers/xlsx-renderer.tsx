"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { useWorkspaceStore } from "@/stores/workspace-store";

interface XlsxRendererProps {
  filePath?: string;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

interface SheetData {
  name: string;
  html: string;
}

export function XlsxRenderer({ filePath }: XlsxRendererProps) {
  const workspace = useWorkspaceStore((s) => s.activeWorkspacePath);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const blobRef = useRef<Blob | null>(null);

  useEffect(() => {
    if (!filePath) {
      setError("No file path provided");
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await api.post<{
          content_base64: string;
          name: string;
        }>(API.FILES.CONTENT_BINARY, { path: filePath, workspace });

        if (cancelled) return;

        setFileName(res.name);
        const buffer = base64ToArrayBuffer(res.content_base64);
        blobRef.current = new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        // Dynamically import xlsx to avoid SSR issues
        const XLSX = await import("xlsx");

        if (cancelled) return;

        const workbook = XLSX.read(buffer, { type: "array" });
        const parsed: SheetData[] = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          const html = XLSX.utils.sheet_to_html(sheet, { id: "xlsx-table", editable: false });
          return { name, html };
        });

        setSheets(parsed);
        setActiveSheet(0);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render spreadsheet");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, workspace]);

  const handleDownload = useCallback(() => {
    if (!blobRef.current) return;
    const url = URL.createObjectURL(blobRef.current);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "spreadsheet.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }, [fileName]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-sm text-[var(--color-destructive)]">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-default)] bg-[var(--surface-tertiary)] shrink-0">
        <span className="text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
          {fileName || "spreadsheet.xlsx"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleDownload}
          disabled={!blobRef.current}
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-0 border-b border-[var(--border-default)] bg-[var(--surface-secondary)] overflow-x-auto shrink-0">
          {sheets.map((sheet, i) => (
            <button
              key={sheet.name}
              onClick={() => setActiveSheet(i)}
              className={`px-3 py-1.5 text-xs font-medium border-r border-[var(--border-default)] transition-colors whitespace-nowrap ${
                i === activeSheet
                  ? "bg-[var(--surface-primary)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-tertiary)]"
              }`}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      {/* Sheet content */}
      <div className="flex-1 overflow-auto bg-[var(--surface-primary)]">
        {sheets[activeSheet] && (
          <div
            className="xlsx-preview-container"
            dangerouslySetInnerHTML={{ __html: sheets[activeSheet].html }}
          />
        )}
      </div>
    </div>
  );
}
