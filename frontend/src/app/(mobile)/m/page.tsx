"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { SquarePen, Settings, Loader2, ChevronRight, Inbox, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { isRemoteMode, autoConnectFromUrl } from "@/lib/remote-connection";
import { useRemoteHealth, type RemoteHealthStatus } from "@/hooks/use-remote-health";
import { PullToRefresh } from "@/components/mobile/pull-to-refresh";
import type { SessionResponse } from "@/types/session";

/** Small colored dot indicating remote connection health. */
function ConnectionDot({ status }: { status: RemoteHealthStatus }) {
  if (status === "unknown") return null;
  const color =
    status === "connected"
      ? "bg-[var(--color-success)]"
      : status === "limited"
        ? "bg-[var(--color-warning)]"
        : "bg-[var(--color-destructive)]";
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${color} shrink-0`}
      title={status}
    />
  );
}

/** Build mobile task route — uses query param in static export (same pattern as desktop). */
function getTaskRoute(sessionId: string): string {
  return `/m/task/_?sessionId=${encodeURIComponent(sessionId)}`;
}

/** Format relative time like "2m ago", "3h ago", "yesterday" */
function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function MobileTaskListPage() {
  const router = useRouter();
  const healthStatus = useRemoteHealth();
  const [sessions, setSessions] = useState<SessionResponse[]>([]);
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set());
  const [needsInputIds, setNeedsInputIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    try {
      const [data, active] = await Promise.all([
        api.get<SessionResponse[]>(API.SESSIONS.LIST(30, 0)),
        api.get<{ stream_id: string; session_id: string; needs_input?: boolean }[]>(API.CHAT.ACTIVE).catch(() => []),
      ]);
      setSessions(data);
      setActiveSessionIds(new Set(active.map((j) => j.session_id)));
      setNeedsInputIds(new Set(active.filter((j) => j.needs_input).map((j) => j.session_id)));
    } catch (err) {
      console.error("Failed to load sessions:", err);
      toast.error("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    autoConnectFromUrl(); // Auto-save token from URL if present
    if (!isRemoteMode()) {
      router.replace("/m/settings");
      return;
    }
    loadSessions();
  }, [router, loadSessions]);

  // Auto-poll when there are active sessions so badges update without pull-to-refresh
  useEffect(() => {
    if (activeSessionIds.size === 0) return;
    const timer = setInterval(loadSessions, 10_000);
    return () => clearInterval(timer);
  }, [activeSessionIds.size, loadSessions]);

  const handleRefresh = useCallback(async () => {
    await loadSessions();
  }, [loadSessions]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),12px)] pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">OpenYak</h1>
          <ConnectionDot status={healthStatus} />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => router.push("/m/new")}
            className="h-9 w-9 flex items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--surface-primary)] active:scale-[0.95] transition-transform"
            aria-label="New task"
          >
            <SquarePen className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={() => router.push("/m/settings")}
            className="h-9 w-9 flex items-center justify-center rounded-full hover:bg-[var(--surface-secondary)] active:scale-[0.95] transition-all"
            aria-label="Settings"
          >
            <Settings className="w-[18px] h-[18px] text-[var(--text-secondary)]" />
          </button>
        </div>
      </header>

      {/* Task list with pull-to-refresh */}
      <PullToRefresh onRefresh={handleRefresh}>
        <div className="px-4 pb-[max(env(safe-area-inset-bottom),8px)]">
          {loading ? (
            <div className="flex items-center justify-center pt-24">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--text-tertiary)]" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center pt-24 gap-3">
              <div className="h-12 w-12 rounded-full bg-[var(--surface-secondary)] flex items-center justify-center">
                <Inbox className="w-5 h-5 text-[var(--text-tertiary)]" />
              </div>
              <p className="text-sm text-[var(--text-tertiary)]">No tasks yet</p>
              <button
                onClick={() => router.push("/m/new")}
                className="mt-2 px-5 py-2.5 rounded-full bg-[var(--text-primary)] text-[var(--surface-primary)] text-sm font-medium active:scale-[0.97] transition-transform"
              >
                Create your first task
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => router.push(getTaskRoute(session.id))}
                  className="w-full text-left px-4 py-3.5 rounded-2xl hover:bg-[var(--surface-secondary)] active:bg-[var(--surface-tertiary)] active:scale-[0.99] transition-all flex items-center gap-3 group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-[15px] font-medium truncate leading-tight">
                        {session.title || "Untitled task"}
                      </p>
                      {needsInputIds.has(session.id) ? (
                        <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/10 text-[var(--color-warning)] text-[10px] font-medium">
                          <MessageCircle className="w-2.5 h-2.5" />
                          Needs input
                        </span>
                      ) : activeSessionIds.has(session.id) ? (
                        <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--color-success)]/10 text-[var(--color-success)] text-[10px] font-medium">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          Running
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                      {timeAgo(session.time_updated)}
                      {session.summary_files > 0 && (
                        <span className="ml-1.5 opacity-60">
                          &middot; {session.summary_files} file{session.summary_files !== 1 ? "s" : ""}
                        </span>
                      )}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </PullToRefresh>
    </div>
  );
}
