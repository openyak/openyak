"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { useWorkspaceStore } from "@/stores/workspace-store";

const PDF_DOCUMENT_OPTIONS = {
  cMapUrl: "/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/standard_fonts/",
} as const;

interface PdfRendererProps {
  filePath?: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function PdfRenderer({ filePath }: PdfRendererProps) {
  const workspace = useWorkspaceStore((s) => s.activeWorkspacePath);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [numPages, setNumPages] = useState(0);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const blobRef = useRef<Blob | null>(null);

  // Dynamically loaded react-pdf components
  const [PdfComponents, setPdfComponents] = useState<{
    Document: React.ComponentType<Record<string, unknown>>;
    Page: React.ComponentType<Record<string, unknown>>;
  } | null>(null);

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

        // Fetch binary content
        const res = await api.post<{
          content_base64: string;
          name: string;
        }>(API.FILES.CONTENT_BINARY, { path: filePath, workspace });

        if (cancelled) return;

        setFileName(res.name);
        const bytes = base64ToUint8Array(res.content_base64);
        blobRef.current = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });

        // Dynamically import react-pdf (SSR-safe)
        const reactPdf = await import("react-pdf");
        // @ts-expect-error -- react-pdf CSS side-effect import
        await import("react-pdf/dist/Page/AnnotationLayer.css");
        // @ts-expect-error -- react-pdf CSS side-effect import
        await import("react-pdf/dist/Page/TextLayer.css");

        // Use local worker file (CDN URLs blocked by Tauri CSP)
        reactPdf.pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        if (cancelled) return;

        setPdfComponents({
          Document: reactPdf.Document as unknown as React.ComponentType<Record<string, unknown>>,
          Page: reactPdf.Page as unknown as React.ComponentType<Record<string, unknown>>,
        });
        setPdfData(bytes);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load PDF");
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
    a.download = fileName || "document.pdf";
    a.click();
    URL.revokeObjectURL(url);
  }, [fileName]);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
  }, []);

  // Memoize the file prop so resizes don't trigger react-pdf reloads
  const documentFile = useMemo(
    () => (pdfData ? { data: pdfData } : null),
    [pdfData],
  );

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-sm text-[var(--color-destructive)]">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar — only page count + download, no duplicate filename */}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-[var(--border-default)] bg-[var(--surface-tertiary)] shrink-0 gap-2">
        {numPages > 1 && (
          <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
            {numPages} pages
          </span>
        )}
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

      {/* Content — scroll through all pages */}
      <div className="flex-1 overflow-auto bg-[var(--surface-secondary)] relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-primary)]">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
          </div>
        )}
        {PdfComponents && documentFile && (
          <PdfComponents.Document
            file={documentFile}
            options={PDF_DOCUMENT_OPTIONS}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={(err: Error) => setError(err.message)}
            loading=""
          >
            <div className="flex flex-col items-center gap-4 py-4">
              {Array.from({ length: numPages }, (_, i) => (
                <PdfComponents.Page
                  key={i + 1}
                  pageNumber={i + 1}
                  width={undefined}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                />
              ))}
            </div>
          </PdfComponents.Document>
        )}
      </div>
    </div>
  );
}
