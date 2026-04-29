"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from 'react-i18next';
import { toast } from "sonner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { API, queryKeys } from "@/lib/constants";
import { api } from "@/lib/api";
import { useChatStore } from "@/stores/chat-store";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useSessions, useDeleteSession, useRenameSession, usePinSession, useArchiveSession, useUnarchiveSession, useSearchSessions } from "@/hooks/use-sessions";
import { useActiveSessionId } from "@/hooks/use-active-session-id";
import { useSessionExport } from "@/hooks/use-session-export";
import { SessionItem } from "./session-item";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { ProjectsToolbar } from "./projects-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Check, ChevronRight, Copy, FolderClosed, FolderOpen, Loader2, MessageSquare, SearchX, SquarePen } from "lucide-react";
import { getChatRoute } from "@/lib/routes";
import { cn, groupSessionsByDate, groupSessionsByWorkspace } from "@/lib/utils";
import type { SessionResponse } from "@/types/session";

type FlatItem =
  | { type: "header"; label: string; first?: boolean }
  | { type: "project"; directory: string; label: string; count: number; collapsed: boolean }
  | { type: "session"; session: SessionResponse; snippet?: string; indent: boolean };

export function SessionList() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const activeSessionId = useActiveSessionId();
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
  const pinSession = usePinSession();
  const archiveSession = useArchiveSession();
  const unarchiveSession = useUnarchiveSession();
  const { exportPdf, exportMarkdown } = useSessionExport();
  const queryClient = useQueryClient();
  const searchQuery = useSidebarStore((s) => s.searchQuery);
  const collapsedProjects = useSidebarStore((s) => s.collapsedProjects);
  const toggleProjectCollapsed = useSidebarStore((s) => s.toggleProjectCollapsed);
  const organizeMode = useSidebarStore((s) => s.organizeMode);
  const sortBy = useSidebarStore((s) => s.sortBy);
  const isContentSearch = searchQuery.trim().length >= 2;
  const hasSearch = searchQuery.trim().length > 0;
  const { data: searchResults, isLoading: isSearching } = useSearchSessions(searchQuery);

  // Flatten infinite query pages into a single, stable list. Offset pagination can
  // briefly overlap pages after pin/archive mutations reorder the server result.
  const sessions = useMemo(() => {
    const seen = new Set<string>();
    const unique: SessionResponse[] = [];
    for (const session of sessionPages?.pages.flat() ?? []) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      unique.push(session);
    }
    return unique;
  }, [sessionPages]);

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
      const seen = new Set<string>();
      const unique: SessionResponse[] = [];
      for (const result of searchResults) {
        if (seen.has(result.session.id)) continue;
        seen.add(result.session.id);
        unique.push(result.session);
      }
      return unique;
    }
    if (!sessions.length) return [];
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) =>
      (s.title ?? "").toLowerCase().includes(q),
    );
  }, [sessions, searchQuery, isContentSearch, searchResults]);

  // Sort sessions by the selected timestamp (desc)
  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      const aVal = sortBy === "created" ? a.time_created : a.time_updated;
      const bVal = sortBy === "created" ? b.time_created : b.time_updated;
      return new Date(bVal).getTime() - new Date(aVal).getTime();
    });
    return list;
  }, [filtered, sortBy]);

  const pinned = useMemo(() => sorted.filter((s) => s.is_pinned), [sorted]);
  const unpinned = useMemo(() => sorted.filter((s) => !s.is_pinned), [sorted]);

  // Directories of the projects currently visible — used by the collapse-all toolbar action.
  const projectDirectories = useMemo(
    () => groupSessionsByWorkspace(unpinned).projects.map((p) => p.directory),
    [unpinned],
  );

  // Flatten into a single list for virtualization. Respects `organizeMode`:
  //  - by-project:    Pinned → Projects (collapsible) → Chats (no workspace)
  //  - chats-first:   Pinned → Chats → Projects
  //  - chronological: Pinned → Today/Yesterday/… (flat, no project grouping)
  // While searching: flat result list, no grouping.
  const flatItems = useMemo(() => {
    const items: FlatItem[] = [];

    if (hasSearch) {
      for (const s of filtered) {
        items.push({ type: "session", session: s, snippet: snippetMap.get(s.id), indent: false });
      }
      return items;
    }

    if (pinned.length > 0) {
      items.push({ type: "header", label: "pinned", first: items.length === 0 });
      for (const s of pinned) {
        items.push({ type: "session", session: s, indent: false });
      }
    }

    if (organizeMode === "chronological") {
      const grouped = groupSessionsByDate(unpinned);
      for (const group of grouped) {
        items.push({ type: "header", label: group.label, first: items.length === 0 });
        for (const s of group.sessions) {
          items.push({ type: "session", session: s, indent: false });
        }
      }
      return items;
    }

    const { projects, chats } = groupSessionsByWorkspace(unpinned);

    const pushProjects = () => {
      if (projects.length === 0) return;
      items.push({ type: "header", label: "projects", first: items.length === 0 });
      for (const p of projects) {
        const collapsed = !!collapsedProjects[p.directory];
        items.push({ type: "project", directory: p.directory, label: p.label, count: p.sessions.length, collapsed });
        if (!collapsed) {
          for (const s of p.sessions) {
            items.push({ type: "session", session: s, indent: true });
          }
        }
      }
    };

    const pushChats = () => {
      if (chats.length === 0) return;
      items.push({ type: "header", label: "chats", first: items.length === 0 });
      for (const s of chats) {
        items.push({ type: "session", session: s, indent: false });
      }
    };

    if (organizeMode === "chats-first") {
      pushChats();
      pushProjects();
    } else {
      pushProjects();
      pushChats();
    }

    return items;
  }, [hasSearch, filtered, pinned, unpinned, snippetMap, collapsedProjects, organizeMode]);

  const flatItemsSignature = useMemo(
    () =>
      flatItems
        .map((item) => {
          if (item.type === "header") return `h:${item.label}:${item.first ? "first" : "rest"}`;
          if (item.type === "project") return `p:${item.directory}:${item.collapsed ? "closed" : "open"}`;
          return `s:${item.session.id}:${item.session.is_pinned ? "pinned" : "chat"}:${item.snippet ? "snippet" : "plain"}`;
        })
        .join("|"),
    [flatItems],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = flatItems[index];
      if (item.type === "header") return item.first ? 24 : 32;
      if (item.type === "project") return 30;
      return item.snippet ? 44 : 30;
    },
    overscan: 10,
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => virtualizer.measure());
    return () => cancelAnimationFrame(frame);
  }, [flatItemsSignature, virtualizer]);

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
  // fully ready yet), retry with exponential backoff so the sidebar hydrates
  // without hammering the backend during recovery.
  useEffect(() => {
    if (!isError) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const retry = () => {
      const delay = Math.min(3000 * Math.pow(2, attempt), 30000);
      timer = setTimeout(() => {
        void refetch();
        attempt++;
        if (attempt < 10) retry();
      }, delay);
    };
    retry();
    return () => clearTimeout(timer);
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

    // If the session being deleted has active generation, abort it first
    const chatState = useChatStore.getState();
    if (chatState.sessionId === id && (chatState.isGenerating || chatState.isCompacting) && chatState.streamId) {
      api.post(API.CHAT.ABORT, { stream_id: chatState.streamId }).catch(() => {});
      chatState.finishGeneration();
    }

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
  }, [deleteTarget, deleteSession, activeSessionId, router, t, queryClient]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  const handleRename = useCallback((id: string, newTitle: string) => {
    renameSession.mutate({ id, title: newTitle });
  }, [renameSession]);

  const handleTogglePin = useCallback((id: string, is_pinned: boolean) => {
    pinSession.mutate({ id, is_pinned });
  }, [pinSession]);

  const handleArchive = useCallback((id: string) => {
    if (activeSessionId === id) {
      router.push(getChatRoute());
    }
    archiveSession.mutate(
      { id },
      {
        onSuccess: () => {
          toast.success(t("conversationArchived"), {
            action: {
              label: t("undo"),
              onClick: () => {
                unarchiveSession.mutate(
                  { id },
                  {
                    onSuccess: () => toast.success(t("conversationRestored")),
                    onError: () => toast.error(t("restoreFailed")),
                  },
                );
              },
            },
          });
        },
        onError: () => toast.error(t("archiveFailed")),
      },
    );
  }, [activeSessionId, archiveSession, router, t, unarchiveSession]);

  const handleEditStart = useCallback((id: string) => {
    setEditingId(id);
  }, []);

  const handleEditEnd = useCallback(() => {
    setEditingId(null);
  }, []);


  if (isLoading || (isContentSearch && isSearching) || (isError && sessions.length === 0)) {
    return (
      <div className="flex-1 px-4 py-3">
        <div className="flex h-full min-h-0 flex-col gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-2xl" />
          ))}
          <div className="flex-1" />
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
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
        className="flex-1 overflow-y-auto overscroll-contain outline-none pt-2 scrollbar-auto"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = flatItems[virtualRow.index];
            const key =
              item.type === "header"
                ? `h-${item.label}-${item.first ? "first" : "rest"}`
                : item.type === "project"
                  ? `p-${item.directory}`
                  : item.session.id;
            return (
              <div
                key={key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className={cn(
                  "absolute left-0 w-full",
                  item.type === "header" && !item.first && "pt-2",
                )}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {item.type === "header" ? (
                  <div className="flex items-center justify-between gap-2 pl-5 pr-3 pb-1 pt-1">
                    <p className="text-ui-3xs font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
                      {t(item.label)}
                    </p>
                    {!hasSearch && item.label === "projects" && (
                      <ProjectsToolbar projectDirectories={projectDirectories} variant="projects" />
                    )}
                    {!hasSearch && item.label === "chats" && (
                      <ProjectsToolbar variant="chats" />
                    )}
                  </div>
                ) : item.type === "project" ? (
                  <ProjectRow
                    directory={item.directory}
                    label={item.label}
                    count={item.count}
                    collapsed={item.collapsed}
                    onToggle={() => toggleProjectCollapsed(item.directory)}
                  />
                ) : (
                  <SessionItem
                    session={item.session}
                    isActive={activeSessionId === item.session.id}
                    onDelete={handleDeleteRequest}
                    onRename={handleRename}
                    onExportPdf={exportPdf}
                    onExportMarkdown={exportMarkdown}
                    onTogglePin={handleTogglePin}
                    onArchive={handleArchive}
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

function ProjectRow({
  directory,
  label,
  count,
  collapsed,
  onToggle,
}: {
  directory: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const startNewChat = useCallback(() => {
    router.push(`/c/new?directory=${encodeURIComponent(directory)}`);
  }, [directory, router]);

  const openDirectory = useCallback(async () => {
    try {
      await api.post(API.FILES.OPEN_SYSTEM, { path: directory });
    } catch (err) {
      console.error("Failed to open directory:", err);
      toast.error(t("openFolderFailed"));
    }
  }, [directory, t]);

  const copyDirectory = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(directory);
      toast.success(t("projectPathCopied"));
    } catch (err) {
      console.error("Failed to copy directory:", err);
      toast.error(t("copyFailed"));
    }
  }, [directory, t]);

  const MenuItems = useCallback(
    ({
      Item,
      Separator,
    }: {
      Item: typeof ContextMenuItem;
      Separator: typeof ContextMenuSeparator;
    }) => (
      <>
        <Item onSelect={startNewChat}>
          <SquarePen />
          {t("startNewChatInProject")}
        </Item>
        <Item onSelect={openDirectory}>
          <FolderOpen />
          {t("openInFinder")}
        </Item>
        <Item onSelect={copyDirectory}>
          <Copy />
          {t("copyWorkingDirectory")}
        </Item>
        <Separator />
        <Item onSelect={onToggle}>
          <Check className={cn(!collapsed && "opacity-0")} />
          {t(collapsed ? "expandProject" : "collapseProject")}
        </Item>
      </>
    ),
    [collapsed, copyDirectory, onToggle, openDirectory, startNewChat, t],
  );

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group/project relative mx-3 rounded-lg focus-within:bg-[var(--sidebar-active)] focus-within:shadow-[var(--sidebar-active-shadow)] data-[state=open]:bg-[var(--sidebar-active)] data-[state=open]:shadow-[var(--sidebar-active-shadow)]",
            menuOpen && "bg-[var(--sidebar-active)] shadow-[var(--sidebar-active-shadow)]",
          )}
        >
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 pr-16 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)] group-focus-within/project:text-[var(--text-primary)] group-data-[state=open]/project:text-[var(--text-primary)]"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-[var(--text-tertiary)] transition-transform",
                !collapsed && "rotate-90",
              )}
            />
            {collapsed ? (
              <FolderClosed className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)] transition-colors group-hover/project:text-[var(--text-secondary)]" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)] transition-colors group-hover/project:text-[var(--text-primary)]" />
            )}
            <span className="flex-1 truncate text-left">{label}</span>
          </button>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ui-3xs text-[var(--text-tertiary)]">
            {count}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <MenuItems Item={ContextMenuItem} Separator={ContextMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
