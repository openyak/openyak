/** Artifact detection and classification utilities. */

import type { ArtifactType } from "@/types/artifact";

/** Map file extensions to artifact types. */
const EXT_MAP: Record<string, ArtifactType> = {
  ".html": "html",
  ".htm": "html",
  ".svg": "svg",
  ".md": "markdown",
  ".mdx": "markdown",
  ".jsx": "react",
  ".tsx": "react",
  ".mermaid": "mermaid",
  ".mmd": "mermaid",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".ppt": "pptx",
  ".csv": "csv",
  ".tsv": "csv",
};

/** Extensions that should render as code (with syntax highlighting). */
const CODE_EXTENSIONS = new Set([
  ".js", ".ts", ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp",
  ".h", ".hpp", ".cs", ".php", ".swift", ".kt", ".scala", ".sh",
  ".bash", ".zsh", ".fish", ".ps1", ".yaml", ".yml", ".json",
  ".toml", ".xml", ".css", ".scss", ".less", ".sql", ".lua",
  ".r", ".m", ".pl", ".ex", ".exs", ".hs", ".clj", ".erl",
  ".vue", ".svelte", ".astro",
]);

/**
 * Determine artifact type from a file extension.
 * Returns null if the file type is not previewable.
 */
export function artifactTypeFromExtension(filePath: string): ArtifactType | null {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (EXT_MAP[ext]) return EXT_MAP[ext];
  if (CODE_EXTENSIONS.has(ext)) return "code";
  // Plain text files
  if (ext === ".txt" || ext === ".log" || ext === ".env" || ext === ".cfg" || ext === ".ini") {
    return "code";
  }
  return null;
}

/**
 * Get programming language name from file extension (for code renderer).
 */
export function languageFromExtension(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    js: "javascript", ts: "typescript", py: "python", rb: "ruby",
    rs: "rust", kt: "kotlin", cs: "csharp", sh: "bash",
    yml: "yaml", md: "markdown", htm: "html",
  };
  return map[ext] || ext;
}

/**
 * Classify a code block (from markdown) as an artifact type.
 * Returns null if the block should stay inline (too small or not suitable).
 */
export function classifyCodeBlock(language: string, code: string): ArtifactType | null {
  const lang = language.toLowerCase();

  if (lang === "mermaid") return "mermaid";
  if (lang === "svg" || (!lang && code.trimStart().startsWith("<svg"))) return "svg";
  if (lang === "html" || (code.includes("<html") || code.includes("<!DOCTYPE"))) {
    if (lang === "html" || lang === "") return "html";
  }
  if (lang === "markdown" || lang === "md") return "markdown";
  if (lang === "jsx" || lang === "tsx") return "react";

  // Generic code — only if substantial
  const lineCount = code.split("\n").length;
  if (lineCount >= 15) return "code";

  return null;
}

/**
 * Check if a file path points to a previewable file type.
 */
export function isPreviewableFile(filePath: string): boolean {
  return artifactTypeFromExtension(filePath) !== null;
}

/**
 * Check if a string looks like a file path (has directory separators + extension).
 * More robust than `isPreviewableFile` — catches any file path including
 * non-previewable formats like .exe, .zip, etc.
 */
export function looksLikeFilePath(text: string): boolean {
  // Reject if contains spaces (likely prose, not a file path) — unless the path uses separators
  const hasPathSep = /[/\\]/.test(text);
  if (!hasPathSep && /\s/.test(text)) return false;
  // Must end with a file extension
  if (!/\.\w{1,10}$/.test(text)) return false;
  // Accept if it has a path separator (full path like /home/user/file.txt)
  if (hasPathSep) return true;
  // Accept bare filenames: must start with optional dot + word chars, have at least one dot
  // Matches: report.txt, .env, package.json, styles.module.css
  // Rejects: single words without extension, sentences, etc.
  return /^\.?\w[\w.-]*\.\w{1,10}$/.test(text);
}
