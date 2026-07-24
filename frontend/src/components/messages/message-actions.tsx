"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Copy, Check, RefreshCw, ThumbsUp, ThumbsDown, ListTree } from "lucide-react";
import { useActivityStore, type ActivityData } from "@/stores/activity-store";

interface MessageActionsProps {
  content: string;
  onRegenerate?: () => void;
  activityData?: ActivityData | null;
  activityKey?: string;
}

export function MessageActions({ content, onRegenerate, activityData, activityKey }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<"up" | "down" | null>(null);
  const toggleForMessage = useActivityStore((s) => s.toggleForMessage);
  const isPanelOpen = useActivityStore((s) => s.isOpen);
  const isActivityOpen = useActivityStore(
    (s) => s.isOpen && !!activityKey && s.activeKey === activityKey,
  );
  const activityTriggerRef = useRef<HTMLButtonElement>(null);
  const wasExpandedRef = useRef(false);

  useEffect(() => {
    if (wasExpandedRef.current && !isPanelOpen) {
      activityTriggerRef.current?.focus();
    }
    wasExpandedRef.current = isActivityOpen;
  }, [isActivityOpen, isPanelOpen]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <div className="flex items-center gap-0.5 pt-2">
      {/* Copy */}
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center justify-center h-7 w-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
        aria-label={copied ? "Copied" : "Copy"}
      >
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.span
              key="check"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
              className="flex items-center justify-center"
            >
              <Check className="h-4 w-4 text-[var(--color-success)]" />
            </motion.span>
          ) : (
            <motion.span
              key="copy"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
              className="flex items-center justify-center"
            >
              <Copy className="h-4 w-4" />
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      {/* Regenerate */}
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="flex items-center justify-center h-7 w-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
          aria-label="Regenerate"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      )}

      {/* Activity */}
      {activityData && activityKey && (
        <button
          ref={activityTriggerRef}
          type="button"
          onClick={() => toggleForMessage(activityKey, activityData)}
          className="flex items-center justify-center h-7 w-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
          aria-label="View activity"
          aria-expanded={isActivityOpen}
          aria-controls="activity-panel"
        >
          <ListTree className="h-4 w-4" />
        </button>
      )}

      {/* Like */}
      <button
        type="button"
        onClick={() => setLiked(liked === "up" ? null : "up")}
        className={`flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
          liked === "up"
            ? "text-[var(--text-primary)] bg-[var(--surface-secondary)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]"
        }`}
        aria-label="Good response"
        aria-pressed={liked === "up"}
      >
        <ThumbsUp className="h-4 w-4" />
      </button>

      {/* Dislike */}
      <button
        type="button"
        onClick={() => setLiked(liked === "down" ? null : "down")}
        className={`flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
          liked === "down"
            ? "text-[var(--text-primary)] bg-[var(--surface-secondary)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]"
        }`}
        aria-label="Bad response"
        aria-pressed={liked === "down"}
      >
        <ThumbsDown className="h-4 w-4" />
      </button>
    </div>
  );
}
