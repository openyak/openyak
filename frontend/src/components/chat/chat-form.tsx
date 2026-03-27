"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
import { useSettingsStore } from "@/stores/settings-store";
import { useProviderModels } from "@/hooks/use-provider-models";
import { useIndexStatus } from "@/hooks/use-index-status";

interface ChatFormProps {
  isGenerating: boolean;
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

function attachmentSuggestions(files: FileAttachment[], t: TFunction): string[] {
  if (files.length === 0) return [];
  const names = files.map((f) => f.name.toLowerCase());
  const hasSheet = names.some((n) => n.endsWith(".xlsx") || n.endsWith(".csv"));
  const hasDoc = names.some((n) => n.endsWith(".docx") || n.endsWith(".pdf"));
  const hasSlides = names.some((n) => n.endsWith(".pptx"));

  const suggestions: string[] = [];
  if (hasSheet) suggestions.push(t('suggestSummarize'));
  if (hasDoc) suggestions.push(t('suggestExtract'));
  if (hasSlides) suggestions.push(t('suggestConvert'));
  if (files.length >= 3) suggestions.push(t('suggestCompare'));
  return suggestions.slice(0, 2);
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

export function ChatForm({ isGenerating, onSend, onStop, className, sessionId, directory }: ChatFormProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const { ref, resize } = useAutoResize();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: providerModels, activeProvider } = useProviderModels();
  const noModelsAvailable = !activeProvider || providerModels.length === 0;

  const sendingRef = useRef(false);

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

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setUploading(true);
    try {
      const results = await Promise.all(
        Array.from(files).map((f) => uploadFile(f))
      );
      setAttachments((prev) => {
        const { merged, duplicateCount } = mergeAttachments(prev, results);
        if (duplicateCount > 0) {
          toast.info(t('duplicateFilesSkipped', { count: duplicateCount }));
        }
        return merged;
      });
      // Ingest into FTS index immediately for existing sessions
      if (sessionId && effectiveWorkspace && results.length > 0) {
        ingestFiles(sessionId, effectiveWorkspace, results.map((r) => r.path));
      }
    } catch (err) {
      console.error("Upload failed:", err);
      toast.error(t('failedUpload'));
    } finally {
      setUploading(false);
    }
  }, [sessionId, effectiveWorkspace]);

  const handleSend = useCallback(async () => {
    if (sendingRef.current || (!input.trim() && attachments.length === 0) || isGenerating) return;
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
  }, [input, attachments, isGenerating, onSend, ref, draftKey]);

  const handleBrowse = useCallback(async () => {
    setUploading(true);
    try {
      const results = await browseFiles();
      if (results.length > 0) {
        setAttachments((prev) => {
          const { merged, duplicateCount } = mergeAttachments(prev, results);
          if (duplicateCount > 0) {
            toast.info(t('duplicateFilesSkipped', { count: duplicateCount }));
          }
          return merged;
        });
        // Ingest into FTS index immediately for existing sessions
        if (sessionId && effectiveWorkspace) {
          ingestFiles(sessionId, effectiveWorkspace, results.map((r) => r.path));
        }
      }
    } catch (err) {
      console.error("Browse failed, falling back to browser picker:", err);
      fileInputRef.current?.click();
    } finally {
      setUploading(false);
    }
  }, [sessionId, effectiveWorkspace]);

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
        setAttachments((prev) => {
          const { merged, duplicateCount } = mergeAttachments(prev, attached);
          if (duplicateCount > 0) {
            toast.info(t('duplicateFilesSkipped', { count: duplicateCount }));
          }
          return merged;
        });
        // Ingest into FTS index immediately for existing sessions
        if (sessionId && effectiveWorkspace) {
          ingestFiles(sessionId, effectiveWorkspace, attached.map((a) => a.path));
        }
      }
    } catch (err) {
      console.error("Failed to attach file:", err);
    }

    // Refocus and resize
    requestAnimationFrame(() => {
      ref.current?.focus();
      resize();
    });
  }, [input, mentionStartIndex, mentionQuery, t, ref, resize, sessionId, effectiveWorkspace]);

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

  const suggestions = attachmentSuggestions(attachments, t);

  return (
    <div className={cn("px-4 pb-4", className)}>
      <div className="mx-auto max-w-3xl xl:max-w-4xl">
        <div
          className={cn(
            "relative rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] shadow-[var(--shadow-sm)] transition-all duration-200 focus-within:shadow-[var(--shadow-md)] focus-within:border-[var(--border-heavy)]",
            isDragOver && "border-[var(--border-heavy)] bg-[var(--surface-tertiary)]",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            if (e.dataTransfer.files.length > 0) {
              handleFiles(e.dataTransfer.files);
            }
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
              onSelect={handleSelect}
              onSubmit={handleSend}
              mentionActive={mentionActive}
              placeholder={noModelsAvailable ? t('noModelPlaceholder') : hasWorkspace ? t('placeholder') + t('placeholderMention') : t('placeholder')}
              className="min-h-[28px] max-h-[200px] py-1"
              disabled={isGenerating || noModelsAvailable}
            />

            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setInput((prev) => (prev ? `${prev}\n${s}` : s));
                      requestAnimationFrame(() => ref.current?.focus());
                    }}
                    className="rounded-full border border-[var(--border-default)] bg-[var(--surface-primary)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-heavy)] transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

          </div>

          {/* Bottom action bar */}
          <div className="flex items-center gap-2 px-3 pb-2.5">
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
                className="shrink-0 flex items-center justify-center h-8 w-8 rounded-full border border-[var(--border-default)] hover:bg-[var(--surface-tertiary)] transition-colors text-[var(--text-secondary)]"
                aria-label={t('attachFile')}
                onClick={handleBrowse}
              >
                <Plus className="h-4 w-4" />
              </button>

              <WorkspaceToggle sessionId={sessionId} directory={directory} isIndexing={isIndexing} />

            <AgentToggle />

            <div className="flex-1" />

            <ChatActions
              isGenerating={isGenerating}
              canSend={(input.trim().length > 0 || attachments.length > 0) && !isIndexing && !noModelsAvailable}
              onSend={handleSend}
              onStop={onStop}
            />
          </div>
        </div>

        <p className="mt-2.5 text-center text-[11px] text-[var(--text-tertiary)]">
          {t('inputHint')}
        </p>
      </div>
    </div>
  );
}

/** Dropdown mode selector: Plan / Ask / Auto — inspired by Claude Code VS Code extension. */
function AgentToggle() {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const workMode = useSettingsStore((s) => s.workMode);
  const setWorkMode = useSettingsStore((s) => s.setWorkMode);

  const modes = [
    { key: "plan" as const, label: t("modePlan"), desc: t("modeDesc_plan") },
    { key: "ask" as const, label: t("modeAsk"), desc: t("modeDesc_ask") },
    { key: "auto" as const, label: t("modeAuto"), desc: t("modeDesc_auto") },
  ];

  const active = modes.find((m) => m.key === workMode) ?? modes[2];

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
