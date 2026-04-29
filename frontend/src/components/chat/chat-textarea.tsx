"use client";

import { forwardRef, useRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface ChatTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  onSubmit?: () => void;
  /** When true, Enter / ArrowUp / ArrowDown are consumed by the mention popup */
  mentionActive?: boolean;
}

const ChatTextarea = forwardRef<HTMLTextAreaElement, ChatTextareaProps>(
  ({
    className,
    onSubmit,
    onKeyDown,
    onCompositionStart,
    onCompositionEnd,
    mentionActive,
    ...props
  }, ref) => {
    const composingRef = useRef(false);
    const compositionEndedAtRef = useRef(0);

    const handleCompositionStart = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = true;
      compositionEndedAtRef.current = 0;
      onCompositionStart?.(e);
    };

    const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
      onCompositionEnd?.(e);
      compositionEndedAtRef.current = Date.now();
      requestAnimationFrame(() => {
        composingRef.current = false;
      });
    };

    const isComposing = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
      const justEndedComposition = Date.now() - compositionEndedAtRef.current < 100;
      return (
        composingRef.current ||
        justEndedComposition ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229
      );
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // When the mention popup is open, let it handle navigation keys
      if (mentionActive) {
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Enter" ||
          e.key === "Tab" ||
          e.key === "Escape"
        ) {
          // These are handled by FileMentionPopup's window keydown listener
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) {
        e.preventDefault();
        onSubmit?.();
      }
      onKeyDown?.(e);
    };

    return (
      <textarea
        ref={ref}
        rows={1}
        className={cn(
          "w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none overflow-y-auto scrollbar-none",
          className,
        )}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        {...props}
      />
    );
  },
);
ChatTextarea.displayName = "ChatTextarea";

export { ChatTextarea };
