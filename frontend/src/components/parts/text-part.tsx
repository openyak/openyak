"use client";

import { useMemo, useCallback, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Copy, Check, PanelRight, FileText, ExternalLink } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { shouldRenderCodeBlockAsSource } from "@/lib/streaming-markdown";
import { useArtifactStore } from "@/stores/artifact-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  classifyCodeBlock,
  isPreviewableFile,
  artifactTypeFromExtension,
  languageFromExtension,
  looksLikeFilePath,
  isAbsoluteFilePath,
} from "@/lib/artifacts";
import type { TextPart as TextPartType } from "@/types/message";
import type { Source } from "@/lib/sources";
import { MermaidBlock } from "./mermaid-block";

interface TextPartProps {
  data: TextPartType;
  isStreaming?: boolean;
  sources?: Source[];
}

// Extract plain text from React children (handles nested elements)
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    const el = node as { props: { children?: React.ReactNode } };
    return extractText(el.props.children);
  }
  return "";
}

// Detect key-value pattern: colon/fullwidth-colon within first 30 chars
function isKeyValue(text: string): boolean {
  const head = text.slice(0, 30);
  return /[:：]/.test(head) && text.length < 80;
}

function ProseParagraph({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement> & { children?: React.ReactNode }) {
  const text = extractText(children);
  const len = text.length;
  const compact = len > 0 && len <= 60;
  const kv = compact && isKeyValue(text);

  const cls = cn(
    kv ? "prose-kv" : compact ? "prose-compact" : undefined,
  );

  return (
    <p className={cls || undefined} {...props}>
      {children}
    </p>
  );
}

function CodeBlock({
  className,
  children,
  isStreaming = false,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode;
  isStreaming?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1] ?? "";
  const code = extractText(children).replace(/\n$/, "");
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const workspaceFiles = useWorkspaceStore((s) => s.workspaceFiles);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  // Classify code block as potential artifact
  const artifactType = classifyCodeBlock(lang, code);

  const handleOpenInPanel = useCallback(() => {
    if (!artifactType) return;
    openArtifact({
      id: `code-${code.length}-${code.slice(0, 32)}`,
      title: lang ? `${lang.charAt(0).toUpperCase() + lang.slice(1)} snippet` : "Code",
      type: artifactType,
      content: code,
      language: lang || undefined,
    });
  }, [artifactType, code, lang, openArtifact]);

  if (!match) {
    // Check if inline code looks like a file path
    const text = String(children).trim();
    const isFilePath = looksLikeFilePath(text);
    const fileName = text.split(/[\\/]/).pop() || text;

    if (isFilePath) {
      const hasPathSegments = /[/\\]/.test(text);
      const isAbsolutePath = isAbsoluteFilePath(text);
      const canPreview = isPreviewableFile(text);

      // Path-like reference + previewable → clickable with artifact preview.
      // Relative paths are allowed here because the backend preview endpoint
      // can resolve them against the active workspace or backend cwd.
      if (hasPathSegments && canPreview) {
        const artifacts = useArtifactStore.getState().artifacts;
        const existing = artifacts.find(
          (a) => a.filePath?.endsWith(fileName) || a.title === fileName,
        );

        const handleOpen = () => {
          if (existing) {
            openArtifact(existing);
          } else {
            const type = artifactTypeFromExtension(text) || "code";
            openArtifact({
              id: `file-preview-${text}`,
              title: fileName,
              type: type === "react" || type === "html" || type === "svg" || type === "mermaid" || type === "markdown" ? type : "file-preview",
              content: "",
              language: languageFromExtension(text),
              filePath: text,
            });
          }
        };

        return (
          <button
            type="button"
            onClick={handleOpen}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-tertiary)] px-2 py-1 align-middle text-left transition-colors hover:bg-[var(--surface-secondary)] hover:border-[var(--border-hover)] cursor-pointer"
            title={text}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
            <span className="truncate text-[0.9em] font-medium text-[var(--text-primary)]">
              {fileName}
            </span>
          </button>
        );
      }

      // Absolute non-previewable paths can still be opened with the OS.
      if (isAbsolutePath) {
        const handleSystemOpen = () => {
          api.post(API.FILES.OPEN_SYSTEM, { path: text }).catch(() => {});
        };

        return (
          <button
            type="button"
            onClick={handleSystemOpen}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-tertiary)] px-2 py-1 align-middle text-left transition-colors hover:bg-[var(--surface-secondary)] hover:border-[var(--border-hover)] cursor-pointer"
            title={text}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
            <span className="truncate text-[0.9em] font-medium text-[var(--text-primary)]">
              {fileName}
            </span>
          </button>
        );
      }

      // Bare filename (no path separator) → clickable when we can uniquely
      // match it to a tracked session file; otherwise keep it as a passive badge.
      const matchingFiles = workspaceFiles.filter((file) => file.name === text);
      if (matchingFiles.length === 1 && isPreviewableFile(matchingFiles[0].path)) {
        const matchedFile = matchingFiles[0];
        const handleOpenTrackedFile = () => {
          const type = artifactTypeFromExtension(matchedFile.path) || "code";
          openArtifact({
            id: `tracked-file-preview-${matchedFile.path}`,
            title: matchedFile.name,
            type:
              type === "react" || type === "html" || type === "svg" || type === "mermaid" || type === "markdown"
                ? type
                : "file-preview",
            content: "",
            language: languageFromExtension(matchedFile.path),
            filePath: matchedFile.path,
          });
        };

        return (
          <button
            type="button"
            onClick={handleOpenTrackedFile}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-tertiary)] px-2 py-1 text-[0.85em] font-mono text-left transition-colors hover:bg-[var(--surface-secondary)] hover:border-[var(--border-hover)] cursor-pointer"
            title="Open file preview"
          >
            <FileText className="h-3 w-3 text-[var(--text-tertiary)] shrink-0" />
            <span className="truncate max-w-[16rem]">{children}</span>
          </button>
        );
      }

      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-tertiary)] px-1.5 py-0.5 text-[0.85em] font-mono border border-[var(--border-default)]">
          <FileText className="h-3 w-3 text-[var(--text-tertiary)] shrink-0" />
          <span>{children}</span>
        </span>
      );
    }

    // Regular inline code
    return (
      <code
        className="rounded-md bg-[var(--surface-tertiary)] px-1.5 py-0.5 text-[0.85em] font-mono border border-[var(--border-default)]"
        {...props}
      >
        {children}
      </code>
    );
  }

  // Detect mermaid code blocks
  if (lang === "mermaid" && !shouldRenderCodeBlockAsSource(lang, isStreaming)) {
    return <MermaidBlock code={code} />;
  }

  // Code block
  const langDisplay = lang
    ? lang.charAt(0).toUpperCase() + lang.slice(1).toLowerCase()
    : "Code";

  return (
    <div className="group relative rounded-2xl overflow-hidden my-6 bg-[var(--code-block-bg)] border border-[var(--code-block-border)]">
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-[var(--code-block-text)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="text-xs font-sans text-[var(--code-block-text)] select-none">{langDisplay}</span>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {artifactType && (
            <button
              onClick={handleOpenInPanel}
              className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-[var(--code-block-text)] hover:text-[var(--code-block-text-hover)] transition-colors"
              title="Open in panel"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-[var(--code-block-text)] hover:text-[var(--code-block-text-hover)] transition-colors"
            title={copied ? "Copied!" : "Copy code"}
          >
            {copied ? (
              <Check className="h-4 w-4 text-[var(--code-block-success)]" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
      <div className="px-4 pb-4">
        <pre className="overflow-x-auto text-[0.8125rem] leading-relaxed">
          <code className={`font-mono ${className}`} {...props}>
            {children}
          </code>
        </pre>
      </div>
    </div>
  );
}

export const TextPart = memo(function TextPart({ data, isStreaming, sources = [] }: TextPartProps) {
  // Build a URL→Source lookup for inline citation matching
  const sourceMap = useMemo(() => {
    const map = new Map<string, Source>();
    for (const s of sources) {
      map.set(s.url, s);
    }
    return map;
  }, [sources]);

  const components = useMemo(
    () => ({
      code: (props: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => (
        <CodeBlock {...props} isStreaming={isStreaming} />
      ),
      p: ProseParagraph,
      // Wrap tables in a rounded, scrollable container
      table: ({ children }: { children?: React.ReactNode }) => (
        <div className="prose-table-wrapper my-6 rounded-lg border border-[var(--border-default)] overflow-x-auto">
          <table>{children}</table>
        </div>
      ),
      // Render matched links as citation badges, otherwise open in new tab
      a: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) => {
        const source = href ? sourceMap.get(href) : undefined;
        if (source) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="no-underline"
              {...props}
            >
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer align-middle mx-0.5">
                {source.favicon && (
                  <Image
                    src={source.favicon}
                    alt=""
                    width={14}
                    height={14}
                    unoptimized
                    className="h-3.5 w-3.5 rounded-sm"
                    loading="lazy"
                  />
                )}
                <span className="truncate max-w-[150px]">{source.domain}</span>
              </span>
            </a>
          );
        }
        return (
          <a target="_blank" rel="noopener noreferrer" href={href} {...props}>
            {children}
          </a>
        );
      },
    }),
    [isStreaming, sourceMap],
  );

  // Skip expensive syntax highlighting during streaming — code blocks are
  // still growing so highlighting is wasted work. Full highlighting runs
  // once streaming finishes (isStreaming becomes false).
  const rehypePlugins = useMemo(
    () => (isStreaming ? [] : [rehypeHighlight]),
    [isStreaming],
  );

  if (!data.text) return null;

  return (
    <div className={cn(
      "prose max-w-none",
      isStreaming && "streaming-cursor",
    )}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {data.text}
      </ReactMarkdown>
    </div>
  );
});
