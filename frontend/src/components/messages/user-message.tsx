"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Copy, Pencil, Check, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { FileChip } from "@/components/chat/file-chip";
import { uploadFile, browseFiles } from "@/lib/upload";
import type { FileAttachment } from "@/types/chat";
import { extractTextFromPartResponses } from "@/lib/utils";
import type { MessageResponse, FilePart as FilePartType } from "@/types/message";

interface UserMessageProps {
  message: MessageResponse;
  /** Whether this message just arrived (animate) or was loaded from history (skip animation). */
  isNew?: boolean;
  /** Callback to edit this message and re-generate from this point. */
  onEditAndResend?: (messageId: string, newText: string, attachments?: FileAttachment[]) => Promise<boolean>;
  /** Whether a generation is currently active (disables edit). */
  isGenerating?: boolean;
}

export function UserMessage({ message, isNew = true, onEditAndResend, isGenerating }: UserMessageProps) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [copied, setCopied] = useState(false);
  const [editAttachments, setEditAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fileParts = message.parts
    .filter((p) => p.data.type === "file")
    .map((p) => p.data as FilePartType);

  const text = extractTextFromPartResponses(message.parts) || (fileParts.length > 0 ? "" : "(empty message)");

  const handleStartEdit = useCallback(() => {
    setEditText(text);
    setEditAttachments(fileParts.map((fp) => ({
      file_id: fp.file_id,
      name: fp.name,
      path: fp.path,
      size: fp.size,
      mime_type: fp.mime_type,
    })));
    setEditing(true);
  }, [text, fileParts]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setEditText("");
    setEditAttachments([]);
  }, []);

  const handleSave = useCallback(async () => {
    if ((!editText.trim() && editAttachments.length === 0) || !onEditAndResend) return;
    const success = await onEditAndResend(message.id, editText, editAttachments);
    if (success) {
      setEditing(false);
      setEditText("");
      setEditAttachments([]);
    }
  }, [editText, editAttachments, message.id, onEditAndResend]);

  const handleUploadFiles = useCallback(async (files: FileList | File[]) => {
    setUploading(true);
    try {
      const results = await Promise.all(
        Array.from(files).map((f) => uploadFile(f))
      );
      setEditAttachments((prev) => [...prev, ...results]);
    } catch (err) {
      console.error("Upload failed:", err);
      toast.error("Failed to upload file");
    } finally {
      setUploading(false);
    }
  }, []);

  const handleBrowse = useCallback(async () => {
    setUploading(true);
    try {
      const results = await browseFiles();
      if (results.length > 0) {
        setEditAttachments((prev) => [...prev, ...results]);
      }
    } catch (err) {
      console.error("Browse failed, falling back to browser picker:", err);
      fileInputRef.current?.click();
    } finally {
      setUploading(false);
    }
  }, []);

  const handleRemoveAttachment = useCallback((fileId: string) => {
    setEditAttachments((prev) => prev.filter((a) => a.file_id !== fileId));
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  // Auto-focus, auto-resize, and scroll into view when entering edit mode.
  // Uses double requestAnimationFrame to run AFTER the MutationObserver in
  // useScrollAnchor, which schedules its own rAF to auto-scroll to bottom
  // whenever DOM content changes. Without this, the MO's scroll-to-bottom
  // overrides our scrollIntoView on the first click.
  useEffect(() => {
    if (editing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          ta.scrollIntoView({ block: "center", behavior: "instant" });
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        });
      });
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[70%] w-full rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border-heavy)] p-4 shadow-[var(--shadow-sm)]">
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={(e) => {
              setEditText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSave();
              }
              if (e.key === "Escape") {
                handleCancel();
              }
            }}
            className="w-full resize-none bg-transparent text-[15px] text-[var(--text-primary)] leading-relaxed outline-none"
            rows={1}
          />
          {(editAttachments.length > 0 || uploading) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {editAttachments.map((att) => (
                <FileChip key={att.file_id} file={att} onRemove={() => handleRemoveAttachment(att.file_id)} />
              ))}
              {uploading && (
                <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                  <span className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full" />
                  Uploading...
                </div>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleUploadFiles(e.target.files);
                e.target.value = "";
              }
            }}
          />
          <p className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] mt-2">
            <RotateCcw className="h-3 w-3 shrink-0" />
            Sending will regenerate the response from this point
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={handleBrowse}
              className="shrink-0 flex items-center justify-center h-8 w-8 rounded-full border border-[var(--border-default)] hover:bg-[var(--surface-tertiary)] transition-colors text-[var(--text-secondary)]"
              aria-label="Attach file"
            >
              <Plus className="h-4 w-4" />
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-1.5 text-sm font-medium rounded-full border border-[var(--border-heavy)] text-[var(--text-primary)] bg-[var(--surface-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!editText.trim() && editAttachments.length === 0}
              className="px-4 py-1.5 text-sm font-medium rounded-full bg-[var(--text-primary)] text-[var(--surface-primary)] hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      className="flex flex-col items-end"
      initial={isNew ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: "spring",
        stiffness: 300,
        damping: 30,
        opacity: { duration: 0.2 },
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl bg-[var(--user-bubble-bg)] px-4 py-2.5 shadow-[var(--shadow-sm)] border border-[var(--border-default)]">
        {text && (
          <div className="text-[15px] text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">
            {text}
          </div>
        )}
        {fileParts.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${text ? "mt-2" : ""}`}>
            {fileParts.map((fp) => (
              <FileChip key={fp.file_id} file={fp} />
            ))}
          </div>
        )}
      </div>

      {/* Action icons — always in DOM to avoid layout shift, opacity-only toggle */}
      <div
        className={`flex items-center gap-0.5 mt-1 mr-1 transition-opacity duration-150 ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {text && (
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center justify-center h-7 w-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
            aria-label={copied ? "Copied" : "Copy message"}
          >
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span
                  key="check"
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 25 }}
                  className="flex items-center justify-center"
                >
                  <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />
                </motion.span>
              ) : (
                <motion.span
                  key="copy"
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center justify-center"
                >
                  <Copy className="h-3.5 w-3.5" />
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        )}
        {onEditAndResend && !isGenerating && (
          <button
            type="button"
            onClick={handleStartEdit}
            className="flex items-center justify-center h-7 w-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
            aria-label="Edit message"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </motion.div>
  );
}
