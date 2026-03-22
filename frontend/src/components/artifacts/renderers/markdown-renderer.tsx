"use client";

import { useState, useCallback } from "react";
import { Copy, Check, Download, FileDown, FileText, Code, Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { API, IS_DESKTOP, resolveApiUrl } from "@/lib/constants";

interface MarkdownRendererProps {
  content: string;
  title?: string;
}

/** Convert a string to a Uint8Array of UTF-8 bytes. */
function toBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Sanitize a title for use as a filename. */
function toFilename(title: string | undefined, ext: string): string {
  if (!title) return `document.${ext}`;
  const safe = title.replace(/[<>:"/\\|?*]/g, "_").trim();
  // Remove existing extension if it matches
  const base = safe.replace(/\.(md|pdf)$/i, "");
  return `${base}.${ext}`;
}

export function MarkdownRenderer({ content, title }: MarkdownRendererProps) {
  const [copied, setCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleDownloadMd = useCallback(async () => {
    const filename = toFilename(title, "md");
    if (IS_DESKTOP) {
      const { desktopAPI } = await import("@/lib/tauri-api");
      await desktopAPI.downloadAndSave({
        data: toBytes(content),
        defaultName: filename,
      });
      return;
    }
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [content, title]);

  const handleDownloadPdf = useCallback(async () => {
    const filename = toFilename(title, "pdf");
    setPdfLoading(true);
    try {
      const res = await fetch(resolveApiUrl(API.ARTIFACTS.EXPORT_PDF), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, title: title || "document" }),
      });
      if (!res.ok) throw new Error("PDF export failed");
      const blob = await res.blob();

      if (IS_DESKTOP) {
        const { desktopAPI } = await import("@/lib/tauri-api");
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        await desktopAPI.downloadAndSave({
          data: bytes,
          defaultName: filename,
        });
        return;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Fallback to .md download on error
      handleDownloadMd();
    } finally {
      setPdfLoading(false);
    }
  }, [content, title, handleDownloadMd]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-default)] bg-[var(--surface-tertiary)] shrink-0">
        <span className="text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
          {showSource ? "Source" : "Preview"}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowSource(!showSource)}
            title={showSource ? "Show preview" : "Show source"}
          >
            {showSource ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={pdfLoading}
                title="Download"
              >
                {pdfLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuItem onClick={handleDownloadPdf} disabled={pdfLoading}>
                <FileDown className="h-3.5 w-3.5" />
                PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDownloadMd}>
                <FileText className="h-3.5 w-3.5" />
                Markdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {/* Content */}
      {showSource ? (
        <pre className="flex-1 overflow-auto p-4 text-[13px] leading-relaxed font-mono text-[var(--text-primary)] bg-[var(--surface-secondary)]">
          {content}
        </pre>
      ) : (
        <div className="flex-1 overflow-auto p-6">
          <div className="prose max-w-none text-[var(--text-primary)] leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
