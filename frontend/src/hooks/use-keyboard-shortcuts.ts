"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface KeyboardShortcutsOptions {
  /** Callback to stop current generation */
  onStop?: () => void;
  /** Callback to copy last message */
  onCopyLast?: () => void;
  /** Whether shortcuts are enabled (default: true) */
  enabled?: boolean;
}

/**
 * Global keyboard shortcuts for the app
 *
 * Shortcuts:
 * - Cmd/Ctrl + K: New chat
 * - Esc: Stop generation
 * - Cmd/Ctrl + Shift + C: Copy last message
 */
export function useKeyboardShortcuts({
  onStop,
  onCopyLast,
  enabled = true,
}: KeyboardShortcutsOptions = {}) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      // Ignore if user is typing in an input/textarea (unless it's Esc)
      const target = e.target as HTMLElement;
      const isTyping =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Esc: Stop generation (works even when typing)
      if (e.key === "Escape") {
        if (onStop) {
          onStop();
        }
        return;
      }

      // Don't process other shortcuts when typing
      if (isTyping) return;

      // Cmd/Ctrl + K: New chat
      if (modKey && e.key === "k") {
        e.preventDefault();
        router.push("/c/new");
        return;
      }

      // Cmd/Ctrl + Shift + C: Copy last message
      if (modKey && e.shiftKey && e.key === "C") {
        e.preventDefault();
        if (onCopyLast) {
          onCopyLast();
        }
        return;
      }

    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onStop, onCopyLast, router]);
}
