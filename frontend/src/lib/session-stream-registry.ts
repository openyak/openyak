"use client";

import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import { toast } from "sonner";
import { SSEClient, type SSEConnectionStatus } from "@/lib/sse";
import { API, IS_DESKTOP, getBackendToken, getBackendUrl, queryKeys } from "@/lib/constants";
import { isRemoteMode } from "@/lib/remote-connection";
import { desktopAPI } from "@/lib/tauri-api";
import { api } from "@/lib/api";
import { SSE_EVENTS } from "@/types/streaming";
import { notifyBackgroundFinish } from "@/lib/background-notify";
import { useChatStore } from "@/stores/chat-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { useWorkspaceStore, type WorkspaceTodo, type WorkspaceFile, type WorkspaceTaskBatch } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { SessionResponse } from "@/types/session";
import type { ArtifactType } from "@/types/artifact";
import type { PaginatedMessages } from "@/types/message";

/**
 * Module-level registry of live SSE streams, keyed by sessionId.
 *
 * Replaces the per-component useSSE hook. Streams continue running across
 * route changes — closing only on terminal events (DONE / abort / agent
 * error / explicit stop). This is what lets a user start a chat in session
 * A, navigate to session B, start another generation, and have both stream
 * concurrently into their own per-session bucket.
 *
 * Each StreamInstance owns its own SSEClient, buffers, last-event-id,
 * debounce/idle timers, etc. Cross-stream concerns (visibility, backend
 * restart) are handled by a single global listener pair that dispatches to
 * every live instance.
 */

const PROGRESSIVE_BUFFER_INTERVAL_MS = 60;

// After a desktop backend restart, wait a beat before reconciling: the
// companion onBackendRestart handler in constants.ts (registered at module
// load, fires in the same event dispatch) must reset the URL/token caches
// first, and the freshly-spawned backend needs a moment to bind its port.
const RESTART_RECONCILE_DELAY_MS = 250;

class ProgressiveBuffer {
  private pending = "";
  private timerId: ReturnType<typeof setTimeout> | null = null;

  constructor(private appendFn: (text: string) => void) {}

  push(text: string) {
    this.pending += text;
    if (!this.timerId) {
      this.timerId = setTimeout(this.flushPending, PROGRESSIVE_BUFFER_INTERVAL_MS);
    }
  }

  flush() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.pending) {
      this.appendFn(this.pending);
      this.pending = "";
    }
  }

  dispose() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.pending = "";
  }

  private flushPending = () => {
    if (!this.pending) {
      this.timerId = null;
      return;
    }
    const chunk = this.pending;
    this.pending = "";
    this.timerId = null;
    this.appendFn(chunk);
  };
}

interface StreamInstance {
  sessionId: string;
  streamId: string;
  client: SSEClient;
  textBuffer: ProgressiveBuffer;
  reasoningBuffer: ProgressiveBuffer;
  stepFinishTimer: ReturnType<typeof setTimeout> | null;
  idleCheckTimer: ReturnType<typeof setInterval> | null;
  mobilePauseTimer: ReturnType<typeof setTimeout> | null;
  lastEventTimestamp: number;
}

const instances = new Map<string, StreamInstance>();

// Sessions whose startStream() is mid-setup (parked on the async backend
// url/token fetch). startStream only registers its instance *after* that await,
// so without this guard a second concurrent start for the same session — e.g.
// restart reconcile firing while a user prompt's start is still in flight —
// would build a second SSEClient, duplicating deltas and leaking an EventSource.
const pendingStarts = new Set<string>();

let queryClientRef: QueryClient | null = null;
let globalListenersInstalled = false;
let unlistenBackendRestarting: (() => void) | null = null;
let unlistenBackendRestarted: (() => void) | null = null;
let unlistenVisibilityChange: (() => void) | null = null;

/**
 * Inject the React Query client. Must be called once before any start().
 * Wired in providers.tsx at app boot.
 */
export function setStreamRegistryQueryClient(qc: QueryClient): void {
  queryClientRef = qc;
}

/** Is there an active stream for this session? */
export function isStreamActive(sessionId: string): boolean {
  return instances.has(sessionId);
}

/** Get the streamId currently attached to this session, if any. */
export function getActiveStreamId(sessionId: string): string | null {
  return instances.get(sessionId)?.streamId ?? null;
}

/** Stop a session's stream (used by the abort flow). Idempotent. */
export function stopStream(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  disposeInstance(instance);
  instances.delete(sessionId);
  if (instances.size === 0) {
    useConnectionStore.getState().setStatus("idle");
  }
}

function disposeInstance(instance: StreamInstance): void {
  if (instance.idleCheckTimer) {
    clearInterval(instance.idleCheckTimer);
    instance.idleCheckTimer = null;
  }
  if (instance.mobilePauseTimer) {
    clearTimeout(instance.mobilePauseTimer);
    instance.mobilePauseTimer = null;
  }
  if (instance.stepFinishTimer) {
    clearTimeout(instance.stepFinishTimer);
    instance.stepFinishTimer = null;
  }
  // Flush any buffered text into the store so navigation doesn't lose it.
  const isGenerating = useChatStore.getState().sessions[instance.sessionId]?.isGenerating;
  if (isGenerating) {
    instance.textBuffer.flush();
    instance.reasoningBuffer.flush();
  }
  instance.textBuffer.dispose();
  instance.reasoningBuffer.dispose();
  instance.client.close();
}

/**
 * Start streaming events for (sessionId, streamId). Idempotent: starting the
 * same (sessionId, streamId) pair twice is a no-op; starting a new streamId
 * for an already-active session closes the old stream first.
 */
export async function startStream(sessionId: string, streamId: string): Promise<void> {
  const existing = instances.get(sessionId);
  if (existing) {
    if (existing.streamId === streamId) return;
    // New stream id for the same session — replace.
    stopStream(sessionId);
  }

  // Reserve this session across the one async gap below. Everything from here
  // to instances.set() is synchronous, so this is enough to serialize starts.
  if (pendingStarts.has(sessionId)) return;
  pendingStarts.add(sessionId);

  if (IS_DESKTOP) {
    try {
      await Promise.all([getBackendUrl(), getBackendToken()]);
    } catch (err) {
      pendingStarts.delete(sessionId);
      throw err;
    }
  }

  ensureGlobalListeners();

  const store = useChatStore;
  const connectionStore = useConnectionStore;

  const textBuffer = new ProgressiveBuffer((text) => {
    store.getState().appendTextDelta(sessionId, text);
  });
  const reasoningBuffer = new ProgressiveBuffer((text) => {
    store.getState().appendReasoningDelta(sessionId, text);
  });

  const waitForNextPaint = () =>
    new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );

  const canFinalizeFromCache = (sid: string) => {
    const qc = queryClientRef;
    if (!qc) return false;
    const data = qc.getQueryData<InfiniteData<PaginatedMessages>>(
      queryKeys.messages.list(sid),
    );
    const latestMessage = data?.pages.at(-1)?.messages.at(-1);
    if (!latestMessage || latestMessage.data.role !== "assistant") return false;
    return latestMessage.parts.some((part) => {
      if (part.data.type !== "step-finish") return false;
      return part.data.reason !== "tool_use";
    });
  };

  const canFinalizeFromPayload = (messages: PaginatedMessages | null | undefined) => {
    const latestMessage = messages?.messages.at(-1);
    if (!latestMessage || latestMessage.data.role !== "assistant") return false;
    return latestMessage.parts.some((part) => {
      if (part.data.type !== "step-finish") return false;
      return part.data.reason !== "tool_use";
    });
  };

  const finishFromDatabase = async (sid: string) => {
    textBuffer.flush();
    reasoningBuffer.flush();
    const qc = queryClientRef;
    if (qc) {
      await qc.invalidateQueries({ queryKey: queryKeys.messages.list(sid) });
      await waitForNextPaint();
    }

    // Do not finalize while the backend still reports this session as active.
    try {
      const activeJobs = await api.get<Array<{ stream_id: string; session_id: string }>>(
        API.CHAT.ACTIVE,
      );
      const ourStreamId = store.getState().sessions[sid]?.streamId;
      const stillActive = activeJobs.some(
        (job) =>
          job.session_id === sid &&
          (!ourStreamId || job.stream_id === ourStreamId),
      );
      if (stillActive) return false;
    } catch {
      // ignore — fall through to DB heuristic
    }

    if (!canFinalizeFromCache(sid)) {
      try {
        const latestPage = await api.get<PaginatedMessages>(API.MESSAGES.LIST(sid, 50, -1));
        if (qc) {
          qc.setQueryData<InfiniteData<PaginatedMessages>>(
            queryKeys.messages.list(sid),
            (old) => {
              if (!old) return { pages: [latestPage], pageParams: [-1] };
              return { ...old, pages: [...old.pages.slice(0, -1), latestPage] };
            },
          );
        }
        if (!canFinalizeFromPayload(latestPage)) return false;
      } catch {
        return false;
      }
    }

    store.getState().finishGeneration(sid);
    if (instances.size === 0) connectionStore.getState().setStatus("idle");
    const workspace = useWorkspaceStore.getState();
    if (
      workspace.todos.length > 0 &&
      workspace.todos.every((todo) => todo.status === "completed")
    ) {
      workspace.collapseSection("progress");
    }
    if (qc) qc.invalidateQueries({ queryKey: queryKeys.sessions.all });
    return true;
  };

  const client = new SSEClient({
    url: API.CHAT.STREAM(streamId),
    urlProvider: () => API.CHAT.STREAM(streamId),
    initialLastEventId: 0,
    onEvent: () => {
      const inst = instances.get(sessionId);
      if (inst) inst.lastEventTimestamp = Date.now();
    },
    onStatusChange: (status) => {
      connectionStore.getState().setStatus(status);
      if (status === "disconnected") {
        toast.error("Connection lost. Response may be incomplete.");
        (async () => {
          try {
            const finished = await finishFromDatabase(sessionId);
            if (finished) {
              stopStream(sessionId);
              return;
            }
          } finally {
            store.getState().finishGeneration(sessionId);
            stopStream(sessionId);
          }
        })();
      }
    },
  });

  const instance: StreamInstance = {
    sessionId,
    streamId,
    client,
    textBuffer,
    reasoningBuffer,
    stepFinishTimer: null,
    idleCheckTimer: null,
    mobilePauseTimer: null,
    lastEventTimestamp: Date.now(),
  };

  const cancelPendingStepFinish = () => {
    if (instance.stepFinishTimer) {
      clearTimeout(instance.stepFinishTimer);
      instance.stepFinishTimer = null;
    }
  };

  // ─── Event handlers ───

  client.on(SSE_EVENTS.MODEL_LOADING, () => {
    store.getState().setModelLoading(sessionId, true);
  });

  client.on(SSE_EVENTS.TEXT_DELTA, (data) => {
    cancelPendingStepFinish();
    const bucket = store.getState().sessions[sessionId];
    if (bucket?.isModelLoading) store.getState().setModelLoading(sessionId, false);
    if (data.text) textBuffer.push(data.text);
  });

  client.on(SSE_EVENTS.REASONING_DELTA, (data) => {
    cancelPendingStepFinish();
    if (data.text) reasoningBuffer.push(data.text);
  });

  client.on(SSE_EVENTS.TOOL_START, (data) => {
    cancelPendingStepFinish();
    if (data.tool && data.call_id) {
      store.getState().addToolStart(
        sessionId,
        data.tool,
        data.call_id,
        data.arguments ?? {},
        data.title,
      );

      if (data.tool === "artifact" && data.arguments) {
        const args = data.arguments as Record<string, string>;
        const command = args.command || "create";
        if (command === "create" && args.type && args.title && args.content) {
          useArtifactStore.getState().openArtifact({
            id: data.call_id,
            type: args.type as ArtifactType,
            title: args.title,
            content: args.content,
            language: args.language,
            identifier: args.identifier,
          });
        }
      }
    }
  });

  client.on(SSE_EVENTS.TOOL_RESULT, (data) => {
    cancelPendingStepFinish();
    if (!data.call_id) return;
    store.getState().setToolResult(
      sessionId,
      data.call_id,
      data.output ?? "",
      data.title,
      data.metadata,
    );

    if (data.tool === "todo" && data.metadata) {
      const meta = data.metadata as { todos?: Array<{ content: string; status: string; activeForm?: string }> };
      if (meta.todos) {
        useWorkspaceStore.getState().setTodos(meta.todos as WorkspaceTodo[]);
        const ws = useWorkspaceStore.getState();
        if (!ws.isOpen) ws.open();
        ws.expandSection("progress");
      }
    }

    if (data.tool && ["write", "edit", "bash", "artifact"].includes(data.tool)) {
      api.get<{ files: Array<{ name: string; path: string; type: string }> }>(
        API.SESSIONS.FILES(sessionId),
      ).then((res) => {
        if (res.files) {
          useWorkspaceStore.getState().setWorkspaceFiles(
            res.files.map((f) => ({ name: f.name, path: f.path, type: f.type as WorkspaceFile["type"] })),
          );
        }
      }).catch((e) => console.warn("[stream-registry] Failed to refresh workspace files:", e));
    }

    if (data.tool === "artifact" && data.metadata) {
      const meta = data.metadata as Record<string, string>;
      if (
        (meta.command === "update" || meta.command === "rewrite") &&
        meta.content &&
        meta.identifier
      ) {
        useArtifactStore.getState().openArtifact({
          id: data.call_id,
          type: (meta.type || "code") as ArtifactType,
          title: meta.title || "Untitled",
          content: meta.content,
          language: meta.language,
          identifier: meta.identifier,
        });
      }
    }
  });

  client.on(SSE_EVENTS.TOOL_ERROR, (data) => {
    cancelPendingStepFinish();
    if (data.call_id) {
      store.getState().setToolError(sessionId, data.call_id, data.output ?? data.error_message ?? "Error");
    }
  });

  client.on(SSE_EVENTS.STEP_START, (data) => {
    cancelPendingStepFinish();
    store.getState().addStepStart(sessionId, data.step ?? 0);
  });

  client.on(SSE_EVENTS.STEP_FINISH, (data, id) => {
    store.getState().addStepFinish(
      sessionId,
      data.reason ?? "stop",
      data.tokens ?? {},
      data.cost ?? 0,
      data.total_cost ?? null,
      id ?? null,
    );

    const terminalReasons = new Set(["stop", "length", "error", "aborted"]);
    const isTerminalStep = terminalReasons.has(data.reason ?? "");
    if (!isTerminalStep) {
      cancelPendingStepFinish();
      return;
    }
    cancelPendingStepFinish();
    instance.stepFinishTimer = setTimeout(async () => {
      instance.stepFinishTimer = null;
      if (!store.getState().sessions[sessionId]?.isGenerating) return;

      const finished = await finishFromDatabase(sessionId);
      if (finished) {
        stopStream(sessionId);
        return;
      }

      // Hard safety net so truly terminal runs do not hang forever.
      instance.stepFinishTimer = setTimeout(async () => {
        instance.stepFinishTimer = null;
        if (!store.getState().sessions[sessionId]?.isGenerating) return;
        console.warn("SSE safety net: forcing finishGeneration after step_finish timeout");
        try {
          const f = await finishFromDatabase(sessionId);
          if (f) {
            stopStream(sessionId);
            return;
          }
        } finally {
          store.getState().finishGeneration(sessionId);
        }
        stopStream(sessionId);
      }, 8_000);
    }, 1_200);
  });

  const updateTaskBatch = (data: { batch_id?: string | null; mode?: string | null; tasks?: unknown[] | null }) => {
    if (!data.batch_id || !data.mode || !Array.isArray(data.tasks)) return;
    const ws = useWorkspaceStore.getState();
    ws.setTaskBatch({
      batch_id: data.batch_id,
      mode: data.mode === "sequential" ? "sequential" : "parallel",
      tasks: data.tasks as WorkspaceTaskBatch["tasks"],
    });
    if (!ws.isOpen) ws.open();
    ws.expandSection("progress");
  };

  client.on(SSE_EVENTS.TASK_BATCH_START, (data) => {
    cancelPendingStepFinish();
    updateTaskBatch(data);
  });
  client.on(SSE_EVENTS.TASK_BATCH_UPDATE, (data) => {
    cancelPendingStepFinish();
    updateTaskBatch(data);
  });
  client.on(SSE_EVENTS.TASK_BATCH_FINISH, (data) => {
    updateTaskBatch(data);
  });

  client.on(SSE_EVENTS.COMPACTION_START, (data) => {
    store.getState().startCompaction(sessionId, data.phases ?? ["prune", "summarize"]);
  });
  client.on(SSE_EVENTS.COMPACTION_PHASE, (data) => {
    if (data.phase && data.status) {
      store.getState().updateCompactionPhase(sessionId, data.phase, data.status);
    }
  });
  client.on(SSE_EVENTS.COMPACTION_PROGRESS, (data) => {
    if (data.phase && data.chars != null) {
      store.getState().updateCompactionProgress(sessionId, data.phase, data.chars);
    }
  });
  client.on(SSE_EVENTS.COMPACTED, (data) => {
    store.getState().addCompaction(sessionId, true);
    if (data.summary_created) toast.success("Context compacted");
  });

  client.on(SSE_EVENTS.PERMISSION_REQUEST, (data) => {
    if (!data.call_id) return;
    const workMode = useSettingsStore.getState().workMode;
    if (workMode === "auto") {
      api.post(API.CHAT.RESPOND, {
        stream_id: streamId,
        call_id: data.call_id,
        response: true,
      }).catch((e) => console.warn("[stream-registry] Failed to auto-approve permission:", e));
      return;
    }
    store.getState().setPermissionRequest(sessionId, {
      callId: data.call_id,
      toolCallId: data.tool_call_id,
      tool: data.tool ?? data.permission ?? "",
      permission: data.permission ?? "",
      patterns: data.patterns ?? [],
      arguments: data.arguments ?? {},
      message: data.message,
      argumentsTruncated: data.arguments_truncated ?? false,
    });
  });

  client.on(SSE_EVENTS.QUESTION, (data) => {
    if (!data.call_id) return;
    store.getState().setQuestion(sessionId, {
      callId: data.call_id,
      tool: data.tool ?? "question",
      arguments: data.arguments ?? { question: data.question, options: data.options, questions: data.questions },
    });
  });

  client.on(SSE_EVENTS.PERMISSION_RESOLVED, (data) => {
    const pending = store.getState().sessions[sessionId]?.pendingPermission;
    if (pending && data.call_id === pending.callId) {
      store.getState().clearPermissionRequest(sessionId);
    }
  });

  client.on(SSE_EVENTS.QUESTION_RESOLVED, (data) => {
    const pending = store.getState().sessions[sessionId]?.pendingQuestion;
    if (pending && data.call_id === pending.callId) {
      store.getState().clearQuestion(sessionId);
    }
  });

  client.on(SSE_EVENTS.PLAN_REVIEW, (data) => {
    if (!data.call_id) return;
    const reviewData = {
      callId: data.call_id,
      title: data.title ?? "Plan",
      plan: data.plan ?? "",
      filesToModify: data.files_to_modify ?? [],
    };
    store.getState().setPlanReview(sessionId, reviewData);
    try {
      const { usePlanReviewStore } = require("@/stores/plan-review-store");
      usePlanReviewStore.getState().openReview(reviewData);
    } catch {
      // ignore — store may not be available during SSR
    }
  });

  client.on(SSE_EVENTS.TITLE_UPDATE, (data) => {
    if (!data.title) return;
    const qc = queryClientRef;
    if (!qc) return;
    qc.setQueryData<InfiniteData<SessionResponse[]>>(
      queryKeys.sessions.all,
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) =>
            page.map((s) => (s.id === sessionId ? { ...s, title: data.title! } : s)),
          ),
        };
      },
    );
    qc.setQueryData<SessionResponse>(
      queryKeys.sessions.detail(sessionId),
      (old) => (old ? { ...old, title: data.title! } : old),
    );
  });

  client.on("heartbeat", () => {
    // No-op: the SSEClient resets its heartbeat timer on any event
  });

  client.on(SSE_EVENTS.DESYNC, () => {
    const qc = queryClientRef;
    if (qc) qc.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
  });

  client.on(SSE_EVENTS.COMPACTION_ERROR, (data) => {
    toast.warning(data.error_message || "Context compression failed. Consider starting a new chat.");
  });

  client.on(SSE_EVENTS.DONE, async () => {
    // Close synchronously before the awaits below: the stream ends right after
    // DONE, so the dying EventSource must not schedule a reconnect to a job
    // that is already complete (→ a spurious "Job not found").
    client.close();
    cancelPendingStepFinish();
    textBuffer.flush();
    reasoningBuffer.flush();
    try {
      await finishFromDatabase(sessionId);
    } finally {
      store.getState().finishGeneration(sessionId);
    }
    const qc = queryClientRef;
    if (qc) {
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
      }, 500);
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all });
      qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
    }
    maybeNotifyFinish(sessionId, "done");
    stopStream(sessionId);
  });

  const handleAgentError = async (data: { error_message?: string | null; code?: string | null }) => {
    // Close the dead connection synchronously, before the awaits below. The
    // server ends the response right after this single error event, so the
    // EventSource would otherwise fire onerror mid-await and schedule a
    // reconnect to a stream the backend no longer has.
    client.close();

    const message = data.error_message ?? "Unknown stream error";
    // A missing job almost always means the local backend restarted out from
    // under an in-flight generation. The conversation is safe in the DB, so
    // recover quietly rather than alarming the user with an opaque toast.
    const streamGone = data.code === "JOB_NOT_FOUND" || message === "Job not found";
    const contextLimitError = /maximum context length|requested about/i.test(message);
    if (streamGone) {
      // Silent — recovered from the DB below.
    } else if (contextLimitError) {
      toast.error("Context too long for this model. Start a new chat or shorten the conversation.");
    } else {
      toast.error(message);
    }
    console.warn("SSE agent error:", message);
    textBuffer.flush();
    reasoningBuffer.flush();
    try {
      await finishFromDatabase(sessionId);
    } finally {
      store.getState().finishGeneration(sessionId);
    }
    const qc = queryClientRef;
    if (qc) {
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
      }, 500);
      qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
    }
    if (!streamGone) maybeNotifyFinish(sessionId, "error", message);
    stopStream(sessionId);
  };
  client.on(SSE_EVENTS.AGENT_ERROR, handleAgentError);
  client.on(SSE_EVENTS.ERROR, handleAgentError);

  client.connect();

  // ─── Per-instance idle recovery ───
  const IDLE_RECOVERY_MS = 15_000;
  const IDLE_CHECK_INTERVAL_MS = 5_000;
  instance.idleCheckTimer = setInterval(async () => {
    if (!store.getState().sessions[sessionId]?.isGenerating) {
      if (instance.idleCheckTimer) {
        clearInterval(instance.idleCheckTimer);
        instance.idleCheckTimer = null;
      }
      return;
    }
    if (instance.lastEventTimestamp > 0 && Date.now() - instance.lastEventTimestamp > IDLE_RECOVERY_MS) {
      console.warn(`SSE idle recovery for ${sessionId}: no events for 15s, attempting DB recovery`);
      const finished = await finishFromDatabase(sessionId);
      if (finished) {
        stopStream(sessionId);
        return;
      }
      instance.lastEventTimestamp = Date.now();
      client.checkHealth();
    }
  }, IDLE_CHECK_INTERVAL_MS);

  instances.set(sessionId, instance);
  pendingStarts.delete(sessionId);
}

// ─── Global cross-stream listeners (installed once on first start) ───

function ensureGlobalListeners(): void {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;

  // Desktop: pause SSE reconnection while backend is restarting; resume after.
  if (IS_DESKTOP) {
    unlistenBackendRestarting = desktopAPI.onBackendRestarting(() => {
      for (const inst of instances.values()) inst.client.pauseReconnect();
    });
    unlistenBackendRestarted = desktopAPI.onBackendRestart(() => {
      // Stop every client's auto-reconnect immediately so none races to a
      // stream_id the freshly-restarted backend no longer has — that race is
      // exactly what produced the spurious "Job not found" toasts. Then
      // reconcile against the new backend once its caches/port have settled.
      for (const inst of instances.values()) inst.client.pauseReconnect();
      setTimeout(() => {
        void reconcileStreamsAfterRestart();
      }, RESTART_RECONCILE_DELAY_MS);
    });
  }

  // Visibility: mobile (remote) pauses streams when hidden to save battery,
  // desktop just rechecks health. Same logic as the old useSSE handler, but
  // applied to every live instance instead of one.
  const handleVisibilityChange = () => {
    for (const inst of instances.values()) {
      if (!store_isGenerating(inst.sessionId)) continue;

      if (document.visibilityState === "visible") {
        if (inst.mobilePauseTimer) {
          clearTimeout(inst.mobilePauseTimer);
          inst.mobilePauseTimer = null;
        }
        inst.client.resumeReconnect();
        inst.client.checkHealth();
      } else if (isRemoteMode()) {
        inst.mobilePauseTimer = setTimeout(() => {
          inst.client.pauseReconnect();
          inst.mobilePauseTimer = null;
        }, 30_000);
      }
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  unlistenVisibilityChange = () => document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function store_isGenerating(sessionId: string): boolean {
  return useChatStore.getState().sessions[sessionId]?.isGenerating ?? false;
}

/**
 * After a desktop backend restart the in-memory StreamManager is empty: every
 * pre-restart stream_id is gone. Blindly reconnecting those dead ids is what
 * surfaced "Job not found" to users. Instead, ask the new backend which
 * generations are actually still running and reconcile each live stream:
 *  - resume it if it survived (a health blip that didn't kill the process),
 *  - re-attach if the backend now reports a different job for that session,
 *  - otherwise finalize it from the DB (the generation died with the old
 *    process; the conversation itself is safe).
 */
async function reconcileStreamsAfterRestart(): Promise<void> {
  if (instances.size === 0) return;

  let activeJobs: Array<{ stream_id: string; session_id: string }> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      activeJobs = await api.get<Array<{ stream_id: string; session_id: string }>>(API.CHAT.ACTIVE);
      break;
    } catch {
      // New backend not serving yet — back off and retry.
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  if (activeJobs === null) {
    // Couldn't confirm backend state. Don't strand the UI in "generating":
    // finalize each interrupted session from the DB so spinners clear and
    // history is refetched. A later user action re-establishes streaming.
    for (const inst of [...instances.values()]) {
      await finalizeInterruptedStream(inst.sessionId);
    }
    return;
  }

  const liveStreamBySession = new Map(activeJobs.map((job) => [job.session_id, job.stream_id]));

  // Sessions we already track are reconciled in the loop below; the final
  // attach loop must skip them so it can't double-start one whose async
  // startStream() has not yet re-registered its instance.
  const handledSessions = new Set(instances.keys());

  for (const inst of [...instances.values()]) {
    const liveStreamId = liveStreamBySession.get(inst.sessionId);
    if (liveStreamId === inst.streamId) {
      inst.client.resumeReconnect();
    } else if (liveStreamId) {
      stopStream(inst.sessionId);
      useChatStore.getState().startGeneration(inst.sessionId, liveStreamId);
      void startStream(inst.sessionId, liveStreamId);
    } else {
      await finalizeInterruptedStream(inst.sessionId);
    }
  }

  // Attach any still-running jobs we are not yet tracking (parity with boot
  // hydration — e.g. a background session started just before the restart).
  for (const job of activeJobs) {
    if (handledSessions.has(job.session_id) || instances.has(job.session_id)) continue;
    useChatStore.getState().startGeneration(job.session_id, job.stream_id);
    void startStream(job.session_id, job.stream_id);
  }
}

/**
 * Wind down a stream whose backend job no longer exists: flush partial output,
 * drop the dead client, clear the generating flag, and refetch authoritative
 * state from the DB. No error toast — an interrupted local generation is a
 * recoverable, expected event, not a failure the user must act on.
 */
async function finalizeInterruptedStream(sessionId: string): Promise<void> {
  stopStream(sessionId); // disposeInstance flushes buffered text while still generating
  useChatStore.getState().finishGeneration(sessionId);
  const qc = queryClientRef;
  if (qc) {
    await qc.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all });
    qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
  }
}

/**
 * Fire a native notification when a session finishes, unless the user is
 * currently looking at that session in the foreground — in that case the
 * normal UI is the notification.
 */
function maybeNotifyFinish(sessionId: string, kind: "done" | "error", errorMessage?: string): void {
  const focusedSessionId = useChatStore.getState().focusedSessionId;
  if (focusedSessionId === sessionId && typeof document !== "undefined" && !document.hidden) {
    return;
  }
  const qc = queryClientRef;
  const session = qc?.getQueryData<SessionResponse>(queryKeys.sessions.detail(sessionId));
  const sessionTitle = session?.title?.trim() || "Background task";
  const title = kind === "done"
    ? `${sessionTitle} finished`
    : `${sessionTitle} stopped`;
  const body = kind === "done"
    ? "Click to open the conversation."
    : (errorMessage ?? "Click to open the conversation.");
  void notifyBackgroundFinish({ sessionId, title, body, kind });
}

/** Cleanup, for tests / hot reload. Not used in production app code. */
export function disposeAllStreams(): void {
  for (const inst of instances.values()) disposeInstance(inst);
  instances.clear();
  pendingStarts.clear();
  unlistenBackendRestarting?.();
  unlistenBackendRestarted?.();
  unlistenVisibilityChange?.();
  unlistenBackendRestarting = null;
  unlistenBackendRestarted = null;
  unlistenVisibilityChange = null;
  globalListenersInstalled = false;
}

// Silence unused-status-import warning — the registry uses the type indirectly.
export type _SSEStatus = SSEConnectionStatus;
