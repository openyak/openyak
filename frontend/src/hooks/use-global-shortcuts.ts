"use client";

import { useCallback, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getChatRoute, resolveSessionId } from "@/lib/routes";
import { useSessions } from "@/hooks/use-sessions";
import { useSidebarStore } from "@/stores/sidebar-store";
import type { SessionResponse } from "@/types/session";

/**
 * App-wide keyboard shortcuts, mounted once by the main layout.
 *
 * - Cmd/Ctrl + B          toggle the sidebar
 * - Cmd/Ctrl + N          new chat (Cmd/Ctrl + Shift + K also works)
 * - Cmd/Ctrl + ,          settings
 * - Cmd/Ctrl + Shift + ]  next conversation
 * - Cmd/Ctrl + Shift + [  previous conversation
 *
 * Chat-scoped actions (Esc to stop, copy last message) stay in
 * `use-keyboard-shortcuts`, which only mounts on chat views.
 */
export function useGlobalShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toggleSidebar = useSidebarStore((s) => s.toggle);
  const { data } = useSessions();

  const cycleSession = useCallback(
    (delta: number) => {
      const sessions: SessionResponse[] = (data?.pages ?? []).flat();
      if (sessions.length === 0) return;

      const pathSessionId = pathname?.startsWith("/c/")
        ? pathname.slice("/c/".length)
        : null;
      const currentId = resolveSessionId(
        pathSessionId,
        searchParams?.get("sessionId"),
      );

      const index = sessions.findIndex((s) => s.id === currentId);
      // Not on a session (or it's gone): enter the list at either end.
      const nextIndex =
        index === -1
          ? delta > 0
            ? 0
            : sessions.length - 1
          : (index + delta + sessions.length) % sessions.length;

      const next = sessions[nextIndex];
      if (next && next.id !== currentId) router.push(getChatRoute(next.id));
    },
    [data, pathname, router, searchParams],
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Accept either modifier, matching search-command-dialog. Deriving the
      // platform from the deprecated navigator.platform is unreliable (it
      // silently disables every binding when the sniff misses).
      const modKey = e.metaKey || e.ctrlKey;
      if (!modKey) return;

      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;

      // Sidebar toggle and settings stay available while typing — they don't
      // consume the composer's text and users reach for them mid-draft.
      if (!e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        router.push("/settings");
        return;
      }

      if (isTyping) return;

      if (!e.shiftKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        router.push("/c/new");
        return;
      }
      if (e.shiftKey && (e.key === "]" || e.key === "}")) {
        e.preventDefault();
        cycleSession(1);
        return;
      }
      if (e.shiftKey && (e.key === "[" || e.key === "{")) {
        e.preventDefault();
        cycleSession(-1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cycleSession, router, toggleSidebar]);
}
