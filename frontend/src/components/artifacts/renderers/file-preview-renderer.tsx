"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { api, apiErrorMessage } from "@/lib/api";
import { API } from "@/lib/constants";
import { artifactTypeFromExtension, languageFromExtension } from "@/lib/artifacts";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { CodeRenderer } from "./code-renderer";
import { MarkdownRenderer } from "./markdown-renderer";
import { HtmlRenderer } from "./html-renderer";
import { SvgRenderer } from "./svg-renderer";
import { MermaidRenderer } from "./mermaid-renderer";
import { ReactRenderer } from "./react-renderer";
import { DocxRenderer } from "./docx-renderer";
import { XlsxRenderer } from "./xlsx-renderer";
import { PdfRenderer } from "./pdf-renderer";
import { PptxRenderer } from "./pptx-renderer";
import { CsvRenderer } from "./csv-renderer";

interface FilePreviewRendererProps {
  /** Disk path of the file. */
  filePath?: string;
  /** Pre-loaded content (from write tool input). */
  content?: string;
  /** Language hint. */
  language?: string;
}

/** Wrapper for binary formats that handle their own fetching. */
function BinaryFilePreview({ filePath }: { filePath?: string }) {
  const type = filePath ? artifactTypeFromExtension(filePath) : null;
  if (type === "docx") return <DocxRenderer filePath={filePath} />;
  if (type === "xlsx") return <XlsxRenderer filePath={filePath} />;
  if (type === "pdf") return <PdfRenderer filePath={filePath} />;
  if (type === "pptx") return <PptxRenderer filePath={filePath} />;
  return null;
}

export function FilePreviewRenderer({ filePath, content: initialContent, language }: FilePreviewRendererProps) {
  // Check if this is a binary format that handles its own fetching
  const artifactType = filePath ? artifactTypeFromExtension(filePath) : null;
  const isBinary = artifactType === "docx" || artifactType === "xlsx" || artifactType === "pdf" || artifactType === "pptx";
  const workspace = useWorkspaceStore((s) => s.activeWorkspacePath);

  const [content, setContent] = useState<string | null>(initialContent ?? null);
  const [loading, setLoading] = useState(!isBinary && !initialContent && !!filePath);
  const [error, setError] = useState<string | null>(null);

  // Fetch text content from disk (skip for binary formats)
  useEffect(() => {
    if (isBinary || initialContent || !filePath) return;

    setLoading(true);
    setError(null);

    api
      .post<{ content: string }>(API.FILES.CONTENT, { path: filePath, workspace })
      .then((res) => {
        setContent(res.content);
      })
      .catch((err) => {
        console.error("[FilePreview] Error:", err);
        setError(apiErrorMessage(err, "Failed to load file"));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [filePath, initialContent, isBinary, workspace]);

  // Binary formats delegate to their own renderers
  if (isBinary) {
    return <BinaryFilePreview filePath={filePath} />;
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-sm text-[var(--color-destructive)]">{error}</p>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-[var(--text-tertiary)]">No content available</p>
      </div>
    );
  }

  // Determine the best renderer based on file extension
  const lang = language || (filePath ? languageFromExtension(filePath) : undefined);

  switch (artifactType) {
    case "html":
      return <HtmlRenderer content={content} title={filePath} />;
    case "svg":
      return <SvgRenderer content={content} />;
    case "markdown":
      return <MarkdownRenderer content={content} />;
    case "mermaid":
      return <MermaidRenderer content={content} />;
    case "react":
      return <ReactRenderer code={content} title={filePath} />;
    case "csv":
      return <CsvRenderer content={content} title={filePath} />;
    default:
      return <CodeRenderer content={content} language={lang} />;
  }
}
