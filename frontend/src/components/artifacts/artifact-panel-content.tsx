"use client";

import { useArtifactStore } from "@/stores/artifact-store";
// Lightweight renderers - loaded synchronously
import { CodeRenderer } from "./renderers/code-renderer";
import { MarkdownRenderer } from "./renderers/markdown-renderer";
import { SvgRenderer } from "./renderers/svg-renderer";
import { MermaidRenderer } from "./renderers/mermaid-renderer";
import { HtmlRenderer } from "./renderers/html-renderer";
import { FilePreviewRenderer } from "./renderers/file-preview-renderer";
import { CsvRenderer } from "./renderers/csv-renderer";
// Heavy renderers - lazy loaded to reduce bundle size
import {
  PdfRenderer,
  PptxRenderer,
  XlsxRenderer,
  DocxRenderer,
  ReactRenderer,
} from "./renderers/lazy-renderers";

export function ArtifactPanelContent() {
  const artifact = useArtifactStore((s) => s.activeArtifact);

  if (!artifact) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-tertiary)]">
        No artifact selected
      </div>
    );
  }

  switch (artifact.type) {
    case "code":
      return <CodeRenderer content={artifact.content} language={artifact.language} />;
    case "markdown":
      return <MarkdownRenderer content={artifact.content} title={artifact.title} />;
    case "svg":
      return <SvgRenderer content={artifact.content} />;
    case "mermaid":
      return <MermaidRenderer content={artifact.content} />;
    case "html":
      return <HtmlRenderer content={artifact.content} title={artifact.title} />;
    case "react":
      return <ReactRenderer code={artifact.content} title={artifact.title} />;
    case "docx":
      return <DocxRenderer filePath={artifact.filePath} />;
    case "xlsx":
      return <XlsxRenderer filePath={artifact.filePath} />;
    case "pdf":
      return <PdfRenderer filePath={artifact.filePath} />;
    case "pptx":
      return <PptxRenderer filePath={artifact.filePath} />;
    case "csv":
      return <CsvRenderer content={artifact.content} title={artifact.title} />;
    case "file-preview":
      return (
        <FilePreviewRenderer
          filePath={artifact.filePath}
          content={artifact.content}
          language={artifact.language}
        />
      );
    default:
      return <CodeRenderer content={artifact.content} language={artifact.language} />;
  }
}
