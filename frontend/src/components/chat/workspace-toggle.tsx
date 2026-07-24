"use client";

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, X } from "lucide-react";
import { Loader2 } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import { browseDirectory } from "@/lib/upload";
import { isRemoteMode } from "@/lib/remote-connection";
import { MobileDirectoryBrowser } from "@/components/mobile/directory-browser";

interface WorkspaceToggleProps {
  /** When provided, workspace changes are persisted to this session via PATCH. */
  sessionId?: string;
  /** The session's current directory (used when sessionId is provided). */
  directory?: string | null;
  /** Whether the workspace is currently being indexed. Shows spinner when true. */
  isIndexing?: boolean;
}

function getDisplayName(path: string | null | undefined): string | null {
  if (!path || path === ".") return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || null;
}

export function WorkspaceToggle({ sessionId, directory, isIndexing }: WorkspaceToggleProps) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  const [browsingDirs, setBrowsingDirs] = useState(false);
  const remote = isRemoteMode();

  // For new chats (no sessionId), use global settings store
  const globalWorkspace = useSettingsStore((s) => s.workspaceDirectory);
  const setGlobalWorkspace = useSettingsStore((s) => s.setWorkspaceDirectory);

  // Resolved values depending on context
  const currentPath = sessionId ? directory : globalWorkspace;
  const displayName = getDisplayName(currentPath);
  const pillLabel = displayName ?? t("workspaceNone");

  // Handle directory selection from either native picker (desktop) or mobile browser
  const applySelectedPath = useCallback(async (path: string) => {
    if (sessionId) {
      await api.patch(API.SESSIONS.DETAIL(sessionId), { directory: path });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    } else {
      setGlobalWorkspace(path);
    }
  }, [sessionId, queryClient, setGlobalWorkspace]);

  const handleBrowse = useCallback(async () => {
    if (remote) {
      // Remote mode: use directory browser instead of native OS dialog
      setBrowsingDirs(true);
      return;
    }
    try {
      const path = await browseDirectory(t("workspaceSet"));
      if (path) {
        await applySelectedPath(path);
      }
    } catch (err) {
      console.error("Failed to browse directory:", err);
      toast.error("Failed to open folder picker");
    }
  }, [remote, t, applySelectedPath]);

  const handleClear = useCallback(async () => {
    if (sessionId) {
      await api.patch(API.SESSIONS.DETAIL(sessionId), { directory: "." });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    } else {
      setGlobalWorkspace(null);
    }
  }, [sessionId, queryClient, setGlobalWorkspace]);

  return (
    <>
      {displayName ? (
        <div
          className="inline-flex items-center rounded-full bg-[var(--surface-tertiary)] text-[var(--text-primary)] max-w-[220px]"
          title={currentPath ?? undefined}
        >
          <button
            type="button"
            onClick={handleBrowse}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-l-full py-1.5 pl-3 pr-1 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
          >
            {isIndexing ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            ) : (
              <FolderOpen className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{pillLabel}</span>
            {isIndexing && (
              <span className="text-[11px] text-[var(--text-tertiary)] shrink-0">Indexing…</span>
            )}
          </button>
          <button
            type="button"
            onClick={handleClear}
            aria-label={t("workspaceClear")}
            className="flex items-center justify-center rounded-r-full py-1.5 pl-1 pr-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleBrowse}
          className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-tertiary)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="truncate">{pillLabel}</span>
        </button>
      )}
      {remote && (
        <MobileDirectoryBrowser
          open={browsingDirs}
          onClose={() => setBrowsingDirs(false)}
          onSelect={(path) => void applySelectedPath(path)}
          initialPath={currentPath}
        />
      )}
    </>
  );
}
