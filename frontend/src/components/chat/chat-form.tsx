"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Plus } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChatTextarea } from "./chat-textarea";
import { ChatActions } from "./chat-actions";
import { WorkspaceToggle } from "./workspace-toggle";
import { FileChip } from "./file-chip";
import { FileMentionPopup } from "./file-mention-popup";
import { useAutoResize } from "@/hooks/use-auto-resize";
import { uploadFile, browseFiles, attachByPath, ingestFiles } from "@/lib/upload";
import type { FileSearchResult } from "@/lib/upload";
import { cn } from "@/lib/utils";
import type { FileAttachment } from "@/types/chat";
import { useArtifactStore } from "@/stores/artifact-store";
import { useChatStore } from "@/stores/chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProviderModels } from "@/hooks/use-provider-models";
import { useIndexStatus } from "@/hooks/use-index-status";
import { formatCreditsPerM, usdToCreditsPerM } from "@/lib/pricing";
import { IS_DESKTOP } from "@/lib/constants";

interface ChatFormProps {
  isGenerating: boolean;
  isCompacting?: boolean;
  onSend: (text: string, attachments?: FileAttachment[]) => Promise<boolean> | void;
  onStop: () => void;
  className?: string;
  sessionId?: string;
  directory?: string | null;
}

/** Persistent per-session draft cache backed by localStorage. */
interface Draft {
  input: string;
  attachments: FileAttachment[];
  savedAt: number;
}

const DRAFT_STORAGE_KEY = "openyak-drafts";
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** In-memory mirror of localStorage drafts — avoids repeated JSON parsing. */
let draftMirror: Map<string, Draft> | null = null;

function loadDrafts(): Map<string, Draft> {
  if (draftMirror) return draftMirror;
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) { draftMirror = new Map(); return draftMirror; }
    const parsed: Record<string, Draft> = JSON.parse(raw);
    const now = Date.now();
    // Evict expired drafts on load
    const entries = Object.entries(parsed).filter(
      ([, d]) => now - d.savedAt < DRAFT_MAX_AGE_MS,
    );
    draftMirror = new Map(entries);
  } catch {
    draftMirror = new Map();
  }
  return draftMirror;
}

function saveDraft(key: string, draft: Draft) {
  const map = loadDrafts();
  map.set(key, draft);
  flushDrafts(map);
}

function deleteDraft(key: string) {
  const map = loadDrafts();
  if (map.delete(key)) flushDrafts(map);
}

function flushDrafts(map: Map<string, Draft>) {
  try {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(map)),
    );
  } catch {
    // localStorage quota exceeded — silently skip
  }
}

function mergeAttachments(
  existing: FileAttachment[],
  incoming: FileAttachment[],
): { merged: FileAttachment[]; duplicateCount: number } {
  const keyOf = (f: FileAttachment) => `${f.path}::${f.size}::${f.name}`;
  const seen = new Set(existing.map(keyOf));
  const unique: FileAttachment[] = [];
  let duplicateCount = 0;

  for (const file of incoming) {
    const key = keyOf(file);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    unique.push(file);
  }

  return {
    merged: [...existing, ...unique],
    duplicateCount,
  };
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

function formatEstimatedUsd(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

type PathBackedFile = File & {
  path?: string;
};

function pathsFromDataTransfer(dataTransfer: DataTransfer): string[] {
  const paths = new Set<string>();

  for (const file of Array.from(dataTransfer.files) as PathBackedFile[]) {
    if (typeof file.path === "string" && file.path) {
      paths.add(file.path);
    }
  }

  for (const item of Array.from(dataTransfer.items ?? [])) {
    const file = item.kind === "file" ? item.getAsFile() as PathBackedFile | null : null;
    if (file?.path) paths.add(file.path);
  }

  return [...paths];
}

function normalizePastedPath(rawPath: string): string | null {
  let path = rawPath.trim();
  if (!path) return null;

  path = path.replace(/^["']|["']$/g, "");

  if (path.startsWith("file://")) {
    try {
      const url = new URL(path);
      const pathname = decodeURIComponent(url.pathname);
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return null;
    }
  }

  const isUnixAbsolute = path.startsWith("/");
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(path);
  const isUncPath = path.startsWith("\\\\");
  if (!isUnixAbsolute && !isWindowsAbsolute && !isUncPath) return null;

  if (isUnixAbsolute) {
    path = path.replace(/\\([ "'()[\]{}])/g, "$1");
  }

  return path;
}

function pathsFromPastedText(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return [];

  const paths = lines.map(normalizePastedPath);
  if (paths.some((path) => !path)) return [];

  return [...new Set(paths as string[])];
}

function pointInsideElement(el: HTMLElement | null, position: { x: number; y: number }): boolean {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const contains = (x: number, y: number) =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  return contains(position.x / ratio, position.y / ratio) || contains(position.x, position.y);
}

/**
 * Find the active @mention trigger in the input text relative to the cursor position.
 * Returns { active: true, query, startIndex } if cursor is inside an @mention,
 * or { active: false } otherwise.
 */
function detectMention(
  text: string,
  cursorPos: number,
): { active: true; query: string; startIndex: number } | { active: false } {
  // Look backwards from cursor for '@'
  const before = text.slice(0, cursorPos);
  const atIndex = before.lastIndexOf("@");
  if (atIndex === -1) return { active: false };

  // '@' must be at start of input or preceded by whitespace
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) {
    return { active: false };
  }

  // Query is text between '@' and cursor — must not contain newlines or spaces
  const query = before.slice(atIndex + 1);
  if (/[\s]/.test(query)) return { active: false };

  return { active: true, query, startIndex: atIndex };
}

export function ChatForm({ isGenerating, isCompacting = false, onSend, onStop, className, sessionId, directory }: ChatFormProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const { ref, resize } = useAutoResize();
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: providerModels, activeProvider } = useProviderModels();
  const noModelsAvailable = !activeProvider || providerModels.length === 0;
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const selectedProviderId = useSettingsStore((s) => s.selectedProviderId);

  const sendingRef = useRef(false);
  const tauriDropHandledAtRef = useRef(0);

  // Track latest values for draft save-on-unmount (avoids stale closures)
  const inputRef = useRef(input);
  const attachmentsRef = useRef(attachments);
  inputRef.current = input;
  attachmentsRef.current = attachments;

  const draftKey = sessionId ?? "__new__";

  // Restore draft on mount (keyed by draftKey)
  useEffect(() => {
    const drafts = loadDrafts();
    const saved = drafts.get(draftKey);
    if (saved) {
      setInput(saved.input);
      setAttachments(saved.attachments);
      deleteDraft(draftKey);
    }
    // Save draft on unmount
    return () => {
      const currentInput = inputRef.current;
      const currentAttachments = attachmentsRef.current;
      if (currentInput.trim() || currentAttachments.length > 0) {
        saveDraft(draftKey, {
          input: currentInput,
          attachments: currentAttachments,
          savedAt: Date.now(),
        });
      }
    };
  }, [draftKey]);

  // @mention state
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);

  const hasWorkspace = !!directory && directory !== ".";

  const globalWorkspace = useSettingsStore((s) => s.workspaceDirectory);
  const effectiveWorkspace = hasWorkspace ? directory : globalWorkspace;
  const { isIndexing } = useIndexStatus(effectiveWorkspace, sessionId);
  const compactingLabel = useChatStore((s) => {
    for (let i = s.streamingParts.length - 1; i >= 0; i -= 1) {
      const part = s.streamingParts[i];
      if (part.type !== "compaction" || part.compactionStatus !== "in_progress") continue;
      const activePhase = part.phases?.find((phase) => phase.status === "started");
      if (!activePhase) return null;
      if (activePhase.phase === "prune") return "prune";
      if (activePhase.phase === "summarize" && activePhase.chars && activePhase.chars > 0) {
        return `summarize:${activePhase.chars}`;
      }
      return "summarize";
    }
    return null;
  });
  const isInputDisabled = isGenerating || isCompacting || noModelsAvailable;

  const addAttachments = useCallback((files: FileAttachment[]) => {
    setAttachments((prev) => {
      const { merged, duplicateCount } = mergeAttachments(prev, files);
      if (duplicateCount > 0) {
        toast.info(t('duplicateFilesSkipped', { count: duplicateCount }));
      }
      return merged;
    });
    if (sessionId && effectiveWorkspace && files.length > 0) {
      ingestFiles(sessionId, effectiveWorkspace, files.map((r) => r.path));
    }
  }, [effectiveWorkspace, sessionId, t]);

  const handleAttachPaths = useCallback(async (paths: string[]) => {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length === 0) return;
    setUploading(true);
    try {
      const attached = await attachByPath(uniquePaths);
      if (attached.length > 0) {
        addAttachments(attached);
      }
    } catch (err) {
      console.error("Attach by path failed:", err);
      toast.error(t('failedUpload'));
    } finally {
      setUploading(false);
    }
  }, [addAttachments, t]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setUploading(true);
    try {
      const results = await Promise.all(
        Array.from(files).map((f) => uploadFile(f))
      );
      addAttachments(results);
    } catch (err) {
      console.error("Upload failed:", err);
      toast.error(t('failedUpload'));
    } finally {
      setUploading(false);
    }
  }, [addAttachments, t]);

  const handleDropDataTransfer = useCallback((dataTransfer: DataTransfer) => {
    const paths = pathsFromDataTransfer(dataTransfer);
    if (paths.length > 0) {
      void handleAttachPaths(paths);
      return;
    }

    const droppedFiles = Array.from(dataTransfer.files);
    if (droppedFiles.length === 0) return;
    if (Date.now() - tauriDropHandledAtRef.current < 750) return;
    window.setTimeout(() => {
      if (Date.now() - tauriDropHandledAtRef.current < 750) return;
      void handleFiles(droppedFiles);
    }, 120);
  }, [handleAttachPaths, handleFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isInputDisabled) return;

    const clipboard = e.clipboardData;
    const clipboardPaths = pathsFromDataTransfer(clipboard);
    if (clipboardPaths.length > 0) {
      e.preventDefault();
      void handleAttachPaths(clipboardPaths);
      return;
    }

    const clipboardFiles = Array.from(clipboard.files);
    if (clipboardFiles.length > 0) {
      e.preventDefault();
      void handleFiles(clipboardFiles);
      return;
    }

    const text = clipboard.getData("text/uri-list") || clipboard.getData("text/plain");
    const pastedPaths = pathsFromPastedText(text);
    if (pastedPaths.length > 0) {
      e.preventDefault();
      void handleAttachPaths(pastedPaths);
    }
  }, [handleAttachPaths, handleFiles, isInputDisabled]);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsDragOver(pointInsideElement(dropTargetRef.current, payload.position));
            return;
          }
          if (payload.type === "leave") {
            setIsDragOver(false);
            return;
          }
          if (payload.type === "drop") {
            setIsDragOver(false);
            if (!pointInsideElement(dropTargetRef.current, payload.position)) return;
            tauriDropHandledAtRef.current = Date.now();
            void handleAttachPaths(payload.paths);
          }
        }),
      )
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.warn("Tauri file drop listener unavailable:", err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleAttachPaths]);

  const handleSend = useCallback(async () => {
    if (sendingRef.current || (!input.trim() && attachments.length === 0) || isGenerating || isCompacting) return;
    sendingRef.current = true;
    try {
      const text = input;
      const files = attachments;
      setInput("");
      setAttachments([]);
      // Clear refs immediately so unmount cleanup won't save stale draft
      inputRef.current = "";
      attachmentsRef.current = [];
      setMentionActive(false);
      if (ref.current) {
        ref.current.style.height = "auto";
      }
      const result = await onSend(text, files.length > 0 ? files : undefined);
      // Restore input if send failed
      if (result === false) {
        setInput(text);
        setAttachments(files);
      } else {
        deleteDraft(draftKey);
      }
    } finally {
      sendingRef.current = false;
    }
  }, [input, attachments, isGenerating, isCompacting, onSend, ref, draftKey]);

  const handleBrowse = useCallback(async () => {
    setUploading(true);
    try {
      const results = await browseFiles();
      if (results.length > 0) {
        addAttachments(results);
      }
    } catch (err) {
      console.error("Browse failed, falling back to browser picker:", err);
      fileInputRef.current?.click();
    } finally {
      setUploading(false);
    }
  }, [addAttachments]);

  const handleRemoveAttachment = useCallback((fileId: string) => {
    setAttachments((prev) => prev.filter((a) => a.file_id !== fileId));
  }, []);

  // Handle @mention file selection
  const handleMentionSelect = useCallback(async (result: FileSearchResult) => {
    // Replace @query with @filename in the input
    const before = input.slice(0, mentionStartIndex);
    const after = input.slice(mentionStartIndex + 1 + mentionQuery.length);
    const newInput = `${before}@${result.name} ${after}`;
    setInput(newInput);
    setMentionActive(false);

    // Attach the file
    try {
      const attached = await attachByPath([result.absolute_path]);
      if (attached.length > 0) {
        addAttachments(attached);
      }
    } catch (err) {
      console.error("Failed to attach file:", err);
    }

    // Refocus and resize
    requestAnimationFrame(() => {
      ref.current?.focus();
      resize();
    });
  }, [input, mentionStartIndex, mentionQuery, ref, resize, addAttachments]);

  const handleMentionClose = useCallback(() => {
    setMentionActive(false);
  }, []);

  // Handle input changes — detect @mention trigger
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursorPos = e.target.selectionStart ?? value.length;
      setInput(value);
      resize();

      if (!hasWorkspace) {
        if (mentionActive) setMentionActive(false);
        return;
      }

      const mention = detectMention(value, cursorPos);
      if (mention.active) {
        setMentionActive(true);
        setMentionQuery(mention.query);
        setMentionStartIndex(mention.startIndex);
      } else {
        if (mentionActive) setMentionActive(false);
      }
    },
    [hasWorkspace, mentionActive, resize],
  );

  // Also check mention state on cursor movement (click, arrow keys)
  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      if (!hasWorkspace) return;
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart ?? 0;
      const mention = detectMention(textarea.value, cursorPos);
      if (mention.active) {
        setMentionActive(true);
        setMentionQuery(mention.query);
        setMentionStartIndex(mention.startIndex);
      } else {
        if (mentionActive) setMentionActive(false);
      }
    },
    [hasWorkspace, mentionActive],
  );

  // Watch for "Try fixing" requests from artifact renderers
  const fixRequest = useArtifactStore((s) => s.fixRequest);
  const clearFixRequest = useArtifactStore((s) => s.clearFixRequest);

  useEffect(() => {
    if (!fixRequest) return;
    setInput(fixRequest);
    clearFixRequest();
    // Focus the textarea
    requestAnimationFrame(() => {
      ref.current?.focus();
      resize();
    });
  }, [fixRequest, clearFixRequest, ref, resize]);

  const selectedModelInfo = useMemo(
    () =>
      providerModels.find(
        (model) =>
          model.id === selectedModel &&
          (!selectedProviderId || model.provider_id === selectedProviderId),
      ) ?? providerModels.find((model) => model.id === selectedModel),
    [providerModels, selectedModel, selectedProviderId],
  );
  const modelCostHint = useMemo(() => {
    if (!selectedModelInfo) return null;
    if (selectedModelInfo.provider_id === "ollama") return "Local";
    if (selectedModelInfo.provider_id === "openai-subscription") return "Included";

    const inputPrice = selectedModelInfo.pricing.prompt || 0;
    const outputPrice = selectedModelInfo.pricing.completion || 0;
    if (inputPrice <= 0 && outputPrice <= 0) return "Free";

    const inputTokens = estimateTextTokens(input);
    const inputCost = inputTokens * inputPrice / 1_000_000;
    const inRate = formatCreditsPerM(usdToCreditsPerM(inputPrice));
    const outRate = formatCreditsPerM(usdToCreditsPerM(outputPrice));

    if (inputTokens > 0) {
      return `Est. input ${formatEstimatedUsd(inputCost)} · out ${outRate}`;
    }
    return `In ${inRate} · out ${outRate}`;
  }, [input, selectedModelInfo]);
  const compactingStatusText = useMemo(() => {
    if (!isCompacting) return null;
    if (!compactingLabel) return t("contextCompactingNow");
    if (compactingLabel === "prune") return t("contextCompactingPrune");
    if (compactingLabel === "summarize") return t("contextCompactingSummarize");
    if (compactingLabel.startsWith("summarize:")) {
      const chars = Number(compactingLabel.split(":")[1] || 0);
      return t("contextCompactingSummarizeProgress", { chars });
    }
    return t("contextCompactingNow");
  }, [compactingLabel, isCompacting, t]);

  return (
    <div className={cn("px-4 pb-4", className)}>
      <div className="mx-auto max-w-3xl xl:max-w-4xl">
        <div
          ref={dropTargetRef}
          className={cn(
            "relative rounded-3xl bg-[var(--surface-secondary)] shadow-[var(--shadow-sm)] transition-all duration-200 focus-within:shadow-[var(--shadow-md)]",
            isDragOver && "ring-1 ring-[var(--border-heavy)]",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            handleDropDataTransfer(e.dataTransfer);
          }}
        >
          {/* @mention popup — positioned above the form */}
          {hasWorkspace && (
            <FileMentionPopup
              query={mentionQuery}
              directory={directory!}
              onSelect={handleMentionSelect}
              onClose={handleMentionClose}
              visible={mentionActive}
            />
          )}

          {/* Inner panel — lighter pill holding textarea + action bar.
              Fully rounded so the bottom corners curve inward, letting the
              darker outer frame the pill on all sides. */}
          <div className="rounded-3xl bg-[var(--surface-tertiary)]">
          {/* Top section: file chips + textarea */}
          <div className="px-4 pt-3 pb-2">
            {/* File chips */}
            {(attachments.length > 0 || uploading) && (
              <div className="flex flex-wrap gap-1.5 pb-2">
                {attachments.map((att) => (
                  <FileChip
                    key={att.file_id}
                    file={att}
                    onRemove={() => handleRemoveAttachment(att.file_id)}
                  />
                ))}
                {uploading && (
                  <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                    <span className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full" />
                    {t('uploading')}
                  </div>
                )}
              </div>
            )}

            <ChatTextarea
              ref={ref}
              value={input}
              onChange={handleInputChange}
              onPaste={handlePaste}
              onSelect={handleSelect}
              onSubmit={handleSend}
              mentionActive={mentionActive}
              placeholder={noModelsAvailable ? t('noModelPlaceholder') : hasWorkspace ? t('placeholder') + t('placeholderMention') : t('placeholder')}
              className="min-h-[28px] max-h-[200px] py-1"
              disabled={isInputDisabled}
            />

          </div>

          {/* Bottom action bar */}
          <div className="flex items-center gap-2 px-3 pb-1.5">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleFiles(e.target.files);
                  e.target.value = "";
                }
              }}
            />

            <button
                type="button"
                disabled={isInputDisabled}
                className="shrink-0 flex items-center justify-center h-8 w-8 rounded-full hover:bg-[var(--surface-tertiary)] transition-colors text-[var(--text-secondary)]"
                aria-label={t('attachFile')}
                onClick={handleBrowse}
              >
                <Plus className="h-4 w-4" />
              </button>

            <div className={cn(isInputDisabled && "pointer-events-none opacity-50")}>
              <AgentToggle />
            </div>

            <div className="flex-1" />

            {compactingStatusText && (
              <div className="mr-1 max-w-[220px] truncate text-[12px] font-medium text-[var(--text-secondary)]">
                {compactingStatusText}
              </div>
            )}

            {modelCostHint && !compactingStatusText && (
              <div
                className="mr-1 max-w-[260px] truncate text-[11px] font-medium text-[var(--text-tertiary)]"
                title={modelCostHint}
              >
                {modelCostHint}
              </div>
            )}

            <ChatActions
              isBusy={isGenerating || isCompacting}
              canSend={(input.trim().length > 0 || attachments.length > 0) && !isIndexing && !isCompacting && !noModelsAvailable}
              onSend={handleSend}
              onStop={onStop}
            />
          </div>
          </div>

          {/* Context row — outer layer, lighter bg, visually wraps the inner panel */}
          <div className={cn(
            "flex items-center gap-2 px-3 py-2",
            isInputDisabled && "pointer-events-none opacity-50",
          )}>
            <WorkspaceToggle sessionId={sessionId} directory={directory} isIndexing={isIndexing} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Dropdown mode selector: Plan / Ask / Auto — inspired by Claude Code VS Code extension. */
function AgentToggle() {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const workMode = useSettingsStore((s) => s.workMode);
  const setWorkMode = useSettingsStore((s) => s.setWorkMode);

  useEffect(() => {
    setMounted(true);
  }, []);

  const modes = [
    { key: "plan" as const, label: t("modePlan"), desc: t("modeDesc_plan") },
    { key: "ask" as const, label: t("modeAsk"), desc: t("modeDesc_ask") },
    { key: "auto" as const, label: t("modeAuto"), desc: t("modeDesc_auto") },
  ];

  const active = modes.find((m) => m.key === workMode) ?? modes[2];

  if (!mounted) {
    return (
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium bg-[var(--surface-tertiary)] text-[var(--text-primary)] opacity-70"
      >
        <span>{active.label}</span>
        <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors bg-[var(--surface-tertiary)] text-[var(--text-primary)] hover:bg-[var(--surface-tertiary)]/80"
        >
          <span>{active.label}</span>
          <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-1.5">
        {modes.map((m) => {
          const isActive = workMode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => { setWorkMode(m.key); setOpen(false); }}
              className={cn(
                "w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                isActive ? "bg-[var(--surface-secondary)]" : "hover:bg-[var(--surface-secondary)]",
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)]">{m.label}</div>
                <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-snug">{m.desc}</div>
              </div>
              {isActive && <Check className="h-4 w-4 shrink-0 mt-0.5 text-[var(--text-primary)]" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
