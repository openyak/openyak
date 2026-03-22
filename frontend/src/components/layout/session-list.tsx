"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useTranslation } from 'react-i18next';
import { toast } from "sonner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { API, IS_DESKTOP, queryKeys, resolveApiUrl } from "@/lib/constants";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useSessions, useDeleteSession, useRenameSession, useSearchSessions } from "@/hooks/use-sessions";
import { SessionItem } from "./session-item";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, MessageSquare, SearchX } from "lucide-react";
import { getChatRoute, resolveSessionId } from "@/lib/routes";
import { cn, groupSessionsByDate } from "@/lib/utils";
import type { SessionResponse } from "@/types/session";

type FlatItem =
  | { type: "header"; label: string }
  | { type: "session"; session: SessionResponse; snippet?: string };

export function SessionList() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const {
    data: sessionPages,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    refetch,
    fetchNextPage,
  } = useSessions();
  const deleteSession = useDeleteSession();
  const renameSession = useRenameSession();
  const queryClient = useQueryClient();
  const searchQuery = useSidebarStore((s) => s.searchQuery);
  const isContentSearch = searchQuery.trim().length >= 2;
  const { data: searchResults, isLoading: isSearching } = useSearchSessions(searchQuery);

  // Flatten infinite query pages into a single array
  const sessions = useMemo(
    () => sessionPages?.pages.flat() ?? [],
    [sessionPages],
  );

  // Roving tabindex: track which session item is focused
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  // Soft delete with undo — refs for delayed deletion
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deletedSessionRef = useRef<{
    id: string;
    data: InfiniteData<SessionResponse[]>;
  } | null>(null);

  // Cleanup pending delete timer on unmount
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) {
        clearTimeout(deleteTimerRef.current);
      }
    };
  }, []);

  // Build a map of session id → snippet for content search results
  const snippetMap = useMemo(() => {
    const map = new Map<string, string>();
    if (searchResults) {
      for (const r of searchResults) {
        if (r.snippet) map.set(r.session.id, r.snippet);
      }
    }
    return map;
  }, [searchResults]);

  const filtered = useMemo(() => {
    if (isContentSearch && searchResults) {
      return searchResults.map((r) => r.session);
    }
    if (!sessions.length) return [];
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) =>
      (s.title ?? "").toLowerCase().includes(q),
    );
  }, [sessions, searchQuery, isContentSearch, searchResults]);

  const grouped = useMemo(() => groupSessionsByDate(filtered), [filtered]);

  // Flatten grouped data into a single list for virtualization
  const flatItems = useMemo(() => {
    const items: FlatItem[] = [];
    for (const group of grouped) {
      items.push({ type: "header", label: group.label });
      for (const session of group.sessions) {
        items.push({ type: "session", session, snippet: snippetMap.get(session.id) });
      }
    }
    return items;
  }, [grouped, snippetMap]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = flatItems[index];
      if (item.type === "header") return index === 0 ? 32 : 40;
      const hasExtra = (item.session.directory && item.session.directory !== ".") || item.snippet;
      return hasExtra ? 58 : 46;
    },
    overscan: 10,
  });

  // Fetch next page when scrolling near bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (
        scrollHeight - scrollTop - clientHeight < 200 &&
        hasNextPage &&
        !isFetchingNextPage &&
        !isContentSearch
      ) {
        fetchNextPage();
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, isContentSearch]);

  // Startup resilience: if the initial sessions request fails (e.g. backend not
  // fully ready yet), keep retrying in background so the sidebar hydrates
  // without requiring a manual action like sending a new message.
  useEffect(() => {
    if (!isError) return;
    const timer = setInterval(() => {
      void refetch();
    }, 3000);
    return () => clearInterval(timer);
  }, [isError, refetch]);

  // Compute session-only indices for keyboard navigation (skip headers)
  const sessionIndices = useMemo(
    () => flatItems.reduce<number[]>((acc, item, i) => {
      if (item.type === "session") acc.push(i);
      return acc;
    }, []),
    [flatItems],
  );

  // Reset focusedIndex when the list changes so stale indices don't linger
  useEffect(() => {
    setFocusedIndex(-1);
  }, [flatItems.length]);

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (sessionIndices.length === 0) return;

      let nextFocused: number | undefined;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const currentPos = sessionIndices.indexOf(focusedIndex);
          nextFocused =
            currentPos < 0 || currentPos >= sessionIndices.length - 1
              ? sessionIndices[0]
              : sessionIndices[currentPos + 1];
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const currentPos = sessionIndices.indexOf(focusedIndex);
          nextFocused =
            currentPos <= 0
              ? sessionIndices[sessionIndices.length - 1]
              : sessionIndices[currentPos - 1];
          break;
        }
        case "Home": {
          e.preventDefault();
          nextFocused = sessionIndices[0];
          break;
        }
        case "End": {
          e.preventDefault();
          nextFocused = sessionIndices[sessionIndices.length - 1];
          break;
        }
        default:
          return;
      }

      if (nextFocused !== undefined) {
        setFocusedIndex(nextFocused);
        virtualizer.scrollToIndex(nextFocused, { align: "auto" });
      }
    },
    [focusedIndex, sessionIndices, virtualizer],
  );

  const handleDeleteRequest = useCallback((id: string, title: string) => {
    setDeleteTarget({ id, title });
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    const activeSessionId = resolveSessionId(
      typeof params.sessionId === "string" ? params.sessionId : null,
      searchParams.get("sessionId"),
    );

    // Save the current cache so we can restore on undo
    const previousData = queryClient.getQueryData<InfiniteData<SessionResponse[]>>(
      queryKeys.sessions.all,
    );

    if (previousData) {
      deletedSessionRef.current = { id, data: previousData };

      // Optimistically remove from cache
      queryClient.setQueryData<InfiniteData<SessionResponse[]>>(
        queryKeys.sessions.all,
        {
          ...previousData,
          pages: previousData.pages.map((page) =>
            page.filter((s) => s.id !== id),
          ),
        },
      );
    }

    // Navigate away immediately if the deleted session is the active one
    if (activeSessionId === id) {
      router.push(getChatRoute());
    }

    // Start 5-second timer — actually delete when it fires
    deleteTimerRef.current = setTimeout(() => {
      deleteTimerRef.current = null;
      deletedSessionRef.current = null;
      deleteSession.mutate(id);
    }, 5000);

    toast(t('conversationDeleted'), {
      action: {
        label: t('undo'),
        onClick: () => {
          // Cancel the pending delete
          if (deleteTimerRef.current) {
            clearTimeout(deleteTimerRef.current);
            deleteTimerRef.current = null;
          }
          // Restore session to cache
          if (deletedSessionRef.current && deletedSessionRef.current.id === id) {
            queryClient.setQueryData<InfiniteData<SessionResponse[]>>(
              queryKeys.sessions.all,
              deletedSessionRef.current.data,
            );
            deletedSessionRef.current = null;
          }
        },
      },
      duration: 5000,
    });

    setDeleteTarget(null);
  }, [deleteTarget, deleteSession, params.sessionId, router, searchParams, t, queryClient]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  const handleRename = useCallback((id: string, newTitle: string) => {
    renameSession.mutate({ id, title: newTitle });
  }, [renameSession]);

  const handleEditStart = useCallback((id: string) => {
    setEditingId(id);
  }, []);

  const handleEditEnd = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleExportPdf = useCallback(async (id: string, title: string) => {
    try {
      const exportUrl = resolveApiUrl(API.SESSIONS.EXPORT_PDF(id));

      if (IS_DESKTOP) {
        const { desktopAPI } = await import("@/lib/tauri-api");
        await desktopAPI.downloadAndSave({ url: exportUrl, defaultName: `${title}.pdf` });
      } else {
        const res = await fetch(exportUrl);
        if (!res.ok) throw new Error("PDF export failed");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;

        let filename = `${title}.pdf`;
        const disposition = res.headers.get("Content-Disposition");
        if (disposition) {
          const utf8Match = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
          if (utf8Match) {
            filename = decodeURIComponent(utf8Match[1]);
          } else {
            const asciiMatch = disposition.match(/filename="(.+?)"/);
            if (asciiMatch) filename = asciiMatch[1];
          }
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("PDF export failed:", err);
      toast.error(t('failedExportPdf'));
    }
  }, []);

  if (isLoading || (isContentSearch && isSearching) || (isError && sessions.length === 0)) {
    return (
      <div className="flex-1 px-3 py-2">
        <div className="flex h-full min-h-0 flex-col gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
          <div className="flex-1" />
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-3">
        {searchQuery ? (
          <>
            <SearchX className="h-8 w-8 text-[var(--text-tertiary)]" />
            <p className="text-xs text-[var(--text-tertiary)] text-center">
              {t('noMatchingConversations')}
            </p>
          </>
        ) : (
          <>
            <MessageSquare className="h-8 w-8 text-[var(--text-tertiary)]" />
            <div className="text-center">
              <p className="text-sm font-medium text-[var(--text-secondary)]">
                {t('noConversationsYet')}
              </p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">
                {t('noConversationsHint')}
              </p>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Conversation list"
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        className="flex-1 overflow-y-auto outline-none pt-1"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = flatItems[virtualRow.index];
            return (
              <div
                key={item.type === "header" ? `h-${item.label}` : item.session.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className={cn(
                  "absolute left-0 w-full",
                  item.type === "session" ? "pb-0.5" : "pb-1",
                  item.type === "header" && virtualRow.index > 0 && "pt-2",
                )}
                style={{ transform: `translateY(${virtualRow.start}px)`, zIndex: flatItems.length - virtualRow.index }}
              >
                {item.type === "header" ? (
                  <p className="px-4 py-2 text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                    {t(item.label)}
                  </p>
                ) : (
                  <SessionItem
                    session={item.session}
                    onDelete={handleDeleteRequest}
                    onRename={handleRename}
                    onExportPdf={handleExportPdf}
                    isEditing={editingId === item.session.id}
                    onEditStart={handleEditStart}
                    onEditEnd={handleEditEnd}
                    snippet={item.snippet}
                    isFocused={virtualRow.index === focusedIndex}
                  />
                )}
              </div>
            );
          })}
        </div>
        {isFetchingNextPage && (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
          </div>
        )}
      </div>

      <DeleteConfirmationDialog
        open={!!deleteTarget}
        title={deleteTarget?.title ?? ""}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </>
  );
}
