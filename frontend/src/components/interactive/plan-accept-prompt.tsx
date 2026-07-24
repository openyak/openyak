"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { isRemoteMode } from "@/lib/remote-connection";

interface PlanAcceptPromptProps {
  onRespond: (action: "accept" | "revise" | "stop", options?: { mode?: "auto" | "ask"; feedback?: string }) => void;
}

/**
 * Replaces the chat input bar when a plan review is pending.
 * Shows 3 options (matching Claude Code's UX) + a text input for feedback.
 */
export function PlanAcceptPrompt({ onRespond }: PlanAcceptPromptProps) {
  const { t } = useTranslation("chat");
  const [feedback, setFeedback] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const isMobile = isRemoteMode();

  // Keyboard shortcuts: 1/2/3 for options, Esc to stop.
  // Only fire when the event target is within this component or on <body>
  // (i.e. no modal/dropdown/overlay is focused).
  useEffect(() => {
    if (isMobile) return; // Skip keyboard handlers on mobile
    const handler = (e: KeyboardEvent) => {
      // Skip if the user is typing in an unrelated input/textarea/contenteditable
      const target = e.target as HTMLElement;
      const isInsideThis = containerRef.current?.contains(target);
      const isBodyLevel = target === document.body;
      if (!isInsideThis && !isBodyLevel) return;

      // If the feedback input is focused, only handle Escape (not number keys)
      const isFeedbackFocused = target.tagName === "INPUT" && isInsideThis;

      if (e.key === "Escape") {
        e.preventDefault();
        onRespond("stop");
      } else if (!isFeedbackFocused) {
        if (e.key === "1") {
          e.preventDefault();
          onRespond("accept", { mode: "auto" });
        } else if (e.key === "2") {
          e.preventDefault();
          onRespond("accept", { mode: "ask" });
        } else if (e.key === "3") {
          e.preventDefault();
          onRespond("stop");
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isMobile, onRespond]);

  const handleFeedbackSubmit = useCallback(() => {
    const text = feedback.trim();
    if (!text) return;
    onRespond("revise", { feedback: text });
    setFeedback("");
  }, [feedback, onRespond]);

  // Mobile layout
  if (isMobile) {
    return (
      <div ref={containerRef} className="px-3 pb-[max(env(safe-area-inset-bottom),8px)]">
        <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-primary)] shadow-lg p-4 space-y-3 animate-slide-up">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-[var(--text-primary)]">
                {t("planAcceptPrompt")}
              </h3>
              <p className="text-sm text-[var(--text-tertiary)] mt-0.5">
                {t("planSelectText")}
              </p>
            </div>
            <button
              onClick={() => onRespond("stop")}
              className="px-3 py-1.5 text-sm text-[var(--text-tertiary)] active:text-[var(--text-primary)]"
            >
              Cancel
            </button>
          </div>

          {/* Option 1: Auto-accept — primary */}
          <button
            onClick={() => onRespond("accept", { mode: "auto" })}
            className="w-full flex items-center gap-3 rounded-xl bg-[var(--brand-primary)] px-4 py-3.5 min-h-[48px] text-left transition-colors active:scale-[0.97]"
          >
            <span className="text-base font-medium text-[var(--brand-primary-text)]">{t("planOptionAutoAccept")}</span>
          </button>

          {/* Option 2: Manual approve */}
          <button
            onClick={() => onRespond("accept", { mode: "ask" })}
            className="w-full flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3.5 min-h-[48px] text-left transition-colors active:scale-[0.97]"
          >
            <span className="text-base font-medium text-[var(--text-primary)]">{t("planOptionManualApprove")}</span>
          </button>

          {/* Option 3: Keep planning */}
          <button
            onClick={() => onRespond("stop")}
            className="w-full flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3.5 min-h-[48px] text-left transition-colors active:scale-[0.97]"
          >
            <span className="text-base font-medium text-[var(--text-primary)]">{t("planOptionKeepPlanning")}</span>
          </button>

          {/* Feedback input */}
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleFeedbackSubmit();
            }}
            placeholder={t("planFeedbackPlaceholder")}
            className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-base text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--ring)] placeholder:text-[var(--text-secondary)]"
          />
        </div>
      </div>
    );
  }

  // Desktop layout
  return (
    <div ref={containerRef} className="px-4 pb-4 pt-2">
      <div className="mx-auto max-w-[736px]">
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 space-y-3 animate-slide-up">
          {/* Header */}
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("planAcceptPrompt")}
            </h3>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
              {t("planSelectText")}
            </p>
          </div>

          {/* Option 1: Yes, and auto-accept — highlighted/primary */}
          <button
            onClick={() => onRespond("accept", { mode: "auto" })}
            className="w-full flex items-center gap-3 rounded-lg bg-[var(--brand-primary)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--brand-primary-hover)]"
          >
            <span className="flex items-center justify-center w-5 h-5 text-xs font-bold shrink-0 text-[var(--brand-primary-text)]/70">1</span>
            <span className="text-sm font-medium text-[var(--brand-primary-text)]">{t("planOptionAutoAccept")}</span>
          </button>

          {/* Option 2: Yes, and manually approve edits */}
          <button
            onClick={() => onRespond("accept", { mode: "ask" })}
            className="w-full flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-tertiary)]"
          >
            <span className="flex items-center justify-center w-5 h-5 text-xs font-bold shrink-0 text-[var(--text-secondary)]">2</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{t("planOptionManualApprove")}</span>
          </button>

          {/* Option 3: No, keep planning */}
          <button
            onClick={() => onRespond("stop")}
            className="w-full flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-tertiary)]"
          >
            <span className="flex items-center justify-center w-5 h-5 text-xs font-bold shrink-0 text-[var(--text-secondary)]">3</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{t("planOptionKeepPlanning")}</span>
          </button>

          {/* Text input for custom feedback */}
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleFeedbackSubmit();
            }}
            placeholder={t("planFeedbackPlaceholder")}
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--ring)] placeholder:text-[var(--text-secondary)]"
          />

          {/* Esc hint */}
          <p className="text-xs text-[var(--text-secondary)]">
            {t("planEscToCancel")}
          </p>
        </div>
      </div>
    </div>
  );
}
