"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { toast } from "sonner";
import { SSEClient } from "@/lib/sse";
import { API, IS_DESKTOP, getBackendUrl, queryKeys } from "@/lib/constants";
import { isRemoteMode } from "@/lib/remote-connection";
import { desktopAPI } from "@/lib/tauri-api";
import { SSE_EVENTS } from "@/types/streaming";
import { useChatStore } from "@/stores/chat-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { useWorkspaceStore, type WorkspaceTodo, type WorkspaceFile } from "@/stores/workspace-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { proxyApi } from "@/lib/proxy-api";
import { api } from "@/lib/api";
import type { SessionResponse } from "@/types/session";
import type { ArtifactType } from "@/types/artifact";
import type { PaginatedMessages } from "@/types/message";

// ─── Module-level state ───
// Persisted across component mounts to survive React navigation.
// When a component unmounts and remounts (e.g., Landing → ChatView),
// the new SSEClient can resume from the last known event ID instead
// of replaying all events and duplicating content in the Zustand store.
let persistedLastEventId = 0;
let currentStreamId: string | null = null;
/** Last time any SSE event was received (milliseconds since epoch). */
let lastEventTimestamp = 0;

/**
 * Progressive text buffer — simulates streaming when provider sends
 * large chunks at once (common with reasoning tokens).
 *
 * Small chunks (< threshold) pass through immediately.
 * Large chunks are progressively revealed via requestAnimationFrame.
 */
/** Min ms between buffer ticks to avoid burning CPU (was 60fps → ~17fps now). */
const PROGRESSIVE_BUFFER_INTERVAL_MS = 60;

class ProgressiveBuffer {
  private pending = "";
  private timerId: ReturnType<typeof setTimeout> | null = null;
  // Characters revealed per tick; larger + throttled interval = smoother and less CPU
  private charsPerFrame = 12;
  private threshold = 40;

  constructor(private appendFn: (text: string) => void) {}

  push(text: string) {
    if (text.length < this.threshold && !this.pending) {
      this.appendFn(text);
      return;
    }
    this.pending += text;
    if (!this.timerId) this.tick();
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

  private tick = () => {
    if (!this.pending) {
      this.timerId = null;
      return;
    }
    const chunk = this.pending.slice(0, this.charsPerFrame);
    this.pending = this.pending.slice(this.charsPerFrame);
    this.appendFn(chunk);
    this.timerId = setTimeout(this.tick, PROGRESSIVE_BUFFER_INTERVAL_MS);
  };
}

/**
 * Connects to the SSE stream for a given streamId and dispatches
 * events to the chatStore.
 */
export function useSSE(streamId: string | null) {
  const clientRef = useRef<SSEClient | null>(null);
  const reasoningBufferRef = useRef<ProgressiveBuffer | null>(null);
  const queryClient = useQueryClient();
  const store = useChatStore;
  const connectionStore = useConnectionStore;

  useEffect(() => {
    if (!streamId) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const start = async () => {
      if (IS_DESKTOP) {
        await getBackendUrl();
      }
      if (cancelled) return;

      // Detect whether this is a brand-new generation or a remount for the
      // same stream (e.g., navigation from Landing → ChatView).
      if (streamId !== currentStreamId) {
        // New generation — reset replay tracking
        persistedLastEventId = 0;
        currentStreamId = streamId;
      }
      // Start the idle clock even before the first SSE event. If the SSE
      // connection fails before delivering any event, lastEventTimestamp would
      // otherwise stay 0 and recovery would wait for SSEClient's full retry
      // exhaustion instead of checking persisted DB state promptly.
      lastEventTimestamp = Date.now();

      const reasoningBuffer = new ProgressiveBuffer((text) => {
        store.getState().appendReasoningDelta(text);
      });
      reasoningBufferRef.current = reasoningBuffer;

      const waitForNextPaint = () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );

      const canFinalizeFromCache = (sessionId: string) => {
        const data = queryClient.getQueryData<InfiniteData<PaginatedMessages>>(
          queryKeys.messages.list(sessionId),
        );
        const latestMessage = data?.pages.at(-1)?.messages.at(-1);
        if (!latestMessage || latestMessage.data.role !== "assistant") return false;

        const hasTerminalStepFinish = latestMessage.parts.some((part) => {
          if (part.data.type !== "step-finish") return false;
          return part.data.reason !== "tool_use";
        });

        return hasTerminalStepFinish;
      };

      const canFinalizeFromPayload = (messages: PaginatedMessages | null | undefined) => {
        const latestMessage = messages?.messages.at(-1);
        if (!latestMessage || latestMessage.data.role !== "assistant") return false;

        return latestMessage.parts.some((part) => {
          if (part.data.type !== "step-finish") return false;
          return part.data.reason !== "tool_use";
        });
      };

      const finishFromDatabase = async (sessionId: string) => {
        reasoningBuffer.flush();
        await queryClient.invalidateQueries({
          queryKey: queryKeys.messages.list(sessionId),
        });
        await waitForNextPaint();

        // Do not finalize from DB while the backend still reports an active
        // generation for this session. Without this guard, an intermediate
        // assistant message that happens to end with a terminal-looking
        // step-finish can prematurely tear down the streaming UI while the
        // same stream continues with more tool calls / follow-up steps.
        try {
          const activeJobs = await api.get<Array<{ stream_id: string; session_id: string }>>(
            API.CHAT.ACTIVE,
          );
          const currentStreamId = store.getState().streamId;
          const stillActive = activeJobs.some(
            (job) =>
              job.session_id === sessionId &&
              (!currentStreamId || job.stream_id === currentStreamId),
          );
          if (stillActive) return false;
        } catch {
          // If the active-job check fails, fall back to the DB heuristic below.
        }

        if (!canFinalizeFromCache(sessionId)) {
          // Hard fallback: read the latest message page directly from the API.
          // Relying only on React Query invalidation is too soft here — if the
          // cache doesn't update in time, the UI can remain stuck in
          // "finalizing" even though the backend has already persisted a
          // terminal assistant message and dropped out of /chat/active.
          try {
            const latestPage = await api.get<PaginatedMessages>(API.MESSAGES.LIST(sessionId, 50, -1));
            queryClient.setQueryData<InfiniteData<PaginatedMessages>>(
              queryKeys.messages.list(sessionId),
              (old) => {
                if (!old) {
                  return {
                    pages: [latestPage],
                    pageParams: [-1],
                  };
                }
                return {
                  ...old,
                  pages: [...old.pages.slice(0, -1), latestPage],
                };
              },
            );
            if (!canFinalizeFromPayload(latestPage)) return false;
          } catch {
            return false;
          }
        }

        store.getState().finishGeneration();
        connectionStore.getState().setStatus("idle");
        const workspace = useWorkspaceStore.getState();
        if (
          workspace.todos.length > 0 &&
          workspace.todos.every((todo) => todo.status === "completed")
        ) {
          workspace.collapseSection("progress");
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
        return true;
      };

      console.log("[SSE] Creating SSEClient for stream:", streamId, "lastEventId:", persistedLastEventId);

      const client = new SSEClient({
        url: API.CHAT.STREAM(streamId),
        // Re-resolve URL on each reconnect so port changes (backend restart) are picked up
        urlProvider: () => API.CHAT.STREAM(streamId),
        initialLastEventId: persistedLastEventId,
        onEvent: () => {
          lastEventTimestamp = Date.now();
          console.log("[SSE] Event received at", Date.now());
        },
        onStatusChange: (status) => {
          console.log("[SSE] Status changed:", status);
          connectionStore.getState().setStatus(status);
          if (status === "disconnected") {
            // Connection permanently lost — clean up streaming state.
            // IMPORTANT: Refetch DB messages BEFORE clearing streaming state,
            // matching the DONE handler pattern. Otherwise StreamingMessage
            // unmounts before DB-fetched AssistantMessageGroup is ready,
            // causing the response to appear blank.
            const sessionId = store.getState().sessionId;
            toast.error("Connection lost. Response may be incomplete.");
            (async () => {
              try {
                if (sessionId) {
                  const finished = await finishFromDatabase(sessionId);
                  if (finished) return;
                }
              } finally {
                store.getState().finishGeneration();
                connectionStore.getState().setStatus("idle");
              }
            })();
          }
        },
      });

    // Model loading (Ollama cold start)
    client.on(SSE_EVENTS.MODEL_LOADING, (_data, id) => {
      persistedLastEventId = id;
      store.getState().setModelLoading(true);
    });

    // Terminal step-finish can occasionally race with the next step's events.
    // Debounce terminalization so a subsequent tool/step event keeps the
    // streaming shell alive instead of collapsing the response mid-run.
    let stepFinishTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingStepFinish = () => {
      if (stepFinishTimer) {
        clearTimeout(stepFinishTimer);
        stepFinishTimer = null;
      }
    };

    // Text streaming
    client.on(SSE_EVENTS.TEXT_DELTA, (data, id) => {
      persistedLastEventId = id;
      cancelPendingStepFinish();
      if (store.getState().isModelLoading) store.getState().setModelLoading(false);
      if (data.text) store.getState().appendTextDelta(data.text);
    });

    client.on(SSE_EVENTS.REASONING_DELTA, (data, id) => {
      persistedLastEventId = id;
      cancelPendingStepFinish();
      if (data.text) reasoningBuffer.push(data.text);
    });

    // Tool lifecycle
    client.on(SSE_EVENTS.TOOL_START, (data, id) => {
      persistedLastEventId = id;
      cancelPendingStepFinish();
      if (data.tool && data.call_id) {
        store.getState().addToolStart(
          data.tool,
          data.call_id,
          data.arguments ?? {},
          data.title,
        );

        // The artifact tool is the explicit presentation path. Generic file
        // writes stay passive so temporary scripts do not interrupt the user.
        // For create: content, type, title are all in args — open immediately
        // For rewrite: content in args, type/title may be absent — open from TOOL_RESULT
        // For update: content is computed server-side — open from TOOL_RESULT
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

    client.on(SSE_EVENTS.TOOL_RESULT, (data, id) => {
      persistedLastEventId = id;
      cancelPendingStepFinish();
      if (data.call_id) {
        store.getState().setToolResult(
          data.call_id,
          data.output ?? "",
          data.title,
          data.metadata,
        );

        // Update workspace panel with todo results
        if (data.tool === "todo" && data.metadata) {
          const meta = data.metadata as { todos?: Array<{ content: string; status: string; activeForm?: string }> };
          if (meta.todos) {
            useWorkspaceStore.getState().setTodos(meta.todos as WorkspaceTodo[]);
            // Auto-open workspace and switch to progress tab
            const ws = useWorkspaceStore.getState();
            if (!ws.isOpen) {
              ws.open();
            }
            ws.expandSection("progress");
          }
        }

        // Refresh workspace files from backend after file-modifying tools
        if (data.tool && ["write", "edit", "bash", "artifact"].includes(data.tool)) {
          const sid = store.getState().sessionId;
          if (sid) {
            api.get<{ files: Array<{ name: string; path: string; type: string }> }>(
              API.SESSIONS.FILES(sid),
            ).then((res) => {
              if (res.files) {
                useWorkspaceStore.getState().setWorkspaceFiles(
                  res.files.map((f) => ({ name: f.name, path: f.path, type: f.type as WorkspaceFile["type"] })),
                );
              }
            }).catch((e) => console.warn("[sse] Failed to refresh workspace files:", e));
          }
        }

        // Explicit file presentation is rendered as an inline file card by
        // MessageContent. The side preview opens only when the user selects it.

        // Update artifact panel for update/rewrite commands
        // (content is computed server-side, not available in TOOL_START args)
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
      }
    });

    client.on(SSE_EVENTS.TOOL_ERROR, (data, id) => {
      persistedLastEventId = id;
      cancelPendingStepFinish();
      if (data.call_id) {
        store.getState().setToolError(data.call_id, data.output ?? data.error_message ?? "Error");
      }
    });

    // Step lifecycle
    client.on(SSE_EVENTS.STEP_START, (data, id) => {
      persistedLastEventId = id;
      cancelPendingStepFinish();
      store.getState().addStepStart(data.step ?? 0);
    });

    // Safety net: if the agent loop finished (terminal step_finish) but DONE
    // never arrives (e.g., lost due to network issues), recover from DB first,
    // then fall back to a delayed finish if needed.
    client.on(SSE_EVENTS.STEP_FINISH, (data, id) => {
      persistedLastEventId = id;
      store.getState().addStepFinish(
        data.reason ?? "stop",
        data.tokens ?? {},
        data.cost ?? 0,
        data.total_cost ?? null,
        id ?? null,
        data.session_id ?? null,
      );

      const terminalReasons = new Set(["stop", "length", "error", "aborted"]);
      const isTerminalStep = terminalReasons.has(data.reason ?? "");
      if (isTerminalStep) {
        cancelPendingStepFinish();
        const sid = store.getState().sessionId;
        stepFinishTimer = setTimeout(async () => {
          stepFinishTimer = null;
          if (!store.getState().isGenerating) return;

          // First, try a short debounced DB recovery. This prevents premature
          // teardown when a bogus terminal reason is immediately followed by a
          // new step-start/tool event.
          if (sid) {
            const finished = await finishFromDatabase(sid);
            if (finished) {
              client.close();
              return;
            }
          }

          // If DONE is still missing after the debounce, keep the original
          // hard safety net so truly terminal runs do not hang forever.
          stepFinishTimer = setTimeout(async () => {
            stepFinishTimer = null;
          if (store.getState().isGenerating) {
            console.warn("SSE safety net: forcing finishGeneration after step_finish timeout");
            try {
              if (sid) {
                const finished = await finishFromDatabase(sid);
                if (finished) {
                  client.close();
                  return;
                }
              }
            } finally {
              store.getState().finishGeneration();
              connectionStore.getState().setStatus("idle");
            }
            client.close();
          }
          }, 8_000);
        }, 1_200);
      } else {
        // Non-terminal step (tool_use) — clear any pending safety timer
        cancelPendingStepFinish();
      }
    });

    // Compaction lifecycle
    client.on(SSE_EVENTS.COMPACTION_START, (data, id) => {
      persistedLastEventId = id;
      store.getState().startCompaction(data.phases ?? ["prune", "summarize"]);
    });

    client.on(SSE_EVENTS.COMPACTION_PHASE, (data, id) => {
      persistedLastEventId = id;
      if (data.phase && data.status) {
        store.getState().updateCompactionPhase(data.phase, data.status);
      }
    });

    client.on(SSE_EVENTS.COMPACTION_PROGRESS, (data, id) => {
      persistedLastEventId = id;
      if (data.phase && data.chars != null) {
        store.getState().updateCompactionProgress(data.phase, data.chars);
      }
    });

    client.on(SSE_EVENTS.COMPACTED, (data, id) => {
      persistedLastEventId = id;
      store.getState().addCompaction(true);
      if (data.summary_created) {
        toast.success("Context compacted");
      }
    });

    // Interactive: Permission
    client.on(SSE_EVENTS.PERMISSION_REQUEST, (data, id) => {
      persistedLastEventId = id;
      if (data.call_id) {
        // In "auto" mode, auto-approve all permission requests
        const workMode = useSettingsStore.getState().workMode;
        if (workMode === "auto") {
          const streamId = store.getState().streamId;
          if (streamId) {
            api.post(API.CHAT.RESPOND, {
              stream_id: streamId,
              call_id: data.call_id,
              response: true,
            }).catch((e) => console.warn("[sse] Failed to auto-approve permission:", e));
            return;
          }
        }
        store.getState().setPermissionRequest({
          callId: data.call_id,
          toolCallId: data.tool_call_id,
          tool: data.tool ?? data.permission ?? "",
          permission: data.permission ?? "",
          patterns: data.patterns ?? [],
          arguments: data.arguments ?? {},
          message: data.message,
          argumentsTruncated: data.arguments_truncated ?? false,
        });
      }
    });

    // Interactive: Question
    client.on(SSE_EVENTS.QUESTION, (data, id) => {
      persistedLastEventId = id;
      console.log("[SSE] QUESTION event received:", { call_id: data.call_id, id, hasArgs: !!data.arguments });
      if (data.call_id) {
        store.getState().setQuestion({
          callId: data.call_id,
          tool: data.tool ?? "question",
          arguments: data.arguments ?? { question: data.question, options: data.options, questions: data.questions },
        });
        console.log("[SSE] pendingQuestion set:", store.getState().pendingQuestion?.callId);
      }
    });

    // Interactive resolved: another client (PC or mobile) already responded
    // to a permission or question prompt — dismiss the local UI.
    client.on(SSE_EVENTS.PERMISSION_RESOLVED, (data, id) => {
      persistedLastEventId = id;
      const pending = store.getState().pendingPermission;
      if (pending && data.call_id === pending.callId) {
        store.getState().clearPermissionRequest();
      }
    });

    client.on(SSE_EVENTS.QUESTION_RESOLVED, (data, id) => {
      persistedLastEventId = id;
      const pending = store.getState().pendingQuestion;
      if (pending && data.call_id === pending.callId) {
        store.getState().clearQuestion();
      }
    });

    // Interactive: Plan Review
    client.on(SSE_EVENTS.PLAN_REVIEW, (data, id) => {
      persistedLastEventId = id;
      if (data.call_id) {
        const reviewData = {
          callId: data.call_id,
          title: data.title ?? "Plan",
          plan: data.plan ?? "",
          filesToModify: data.files_to_modify ?? [],
        };
        store.getState().setPlanReview(reviewData);
        // Open the plan review panel with data
        try {
          const { usePlanReviewStore } = require("@/stores/plan-review-store");
          usePlanReviewStore.getState().openReview(reviewData);
        } catch {
          // Store may not be available during SSR
        }
      }
    });

    // Title update — live title refresh during streaming
    client.on(SSE_EVENTS.TITLE_UPDATE, (data, id) => {
      persistedLastEventId = id;
      if (data.title) {
        const sessionId = store.getState().sessionId;
        if (sessionId) {
          queryClient.setQueryData<InfiniteData<SessionResponse[]>>(
            queryKeys.sessions.all,
            (old) => {
              if (!old) return old;
              return {
                ...old,
                pages: old.pages.map((page) =>
                  page.map((s) =>
                    s.id === sessionId ? { ...s, title: data.title! } : s,
                  ),
                ),
              };
            },
          );
          queryClient.setQueryData<SessionResponse>(
            queryKeys.sessions.detail(sessionId),
            (old) => (old ? { ...old, title: data.title! } : old),
          );
        }
      }
    });

    // Heartbeat — keeps the connection alive
    client.on("heartbeat", () => {
      // No-op: the SSEClient resets its heartbeat timer on any event
    });

    // Desync — backend dropped events due to subscriber queue overflow.
    // Refetch messages from DB, but keep the current streaming shell alive until
    // we have something better to show. Clearing first causes visible blank gaps.
    client.on(SSE_EVENTS.DESYNC, (_data, id) => {
      persistedLastEventId = id;
      const sessionId = store.getState().sessionId;
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
      }
    });

    client.on(SSE_EVENTS.COMPACTION_ERROR, (data, id) => {
      persistedLastEventId = id;
      toast.warning(data.error_message || "Context compression failed. Consider starting a new chat.");
    });

    // Completion
    client.on(SSE_EVENTS.DONE, async (_data, id) => {
      persistedLastEventId = id;
      cancelPendingStepFinish();
      reasoningBuffer.flush();
      const sessionId = store.getState().sessionId;

      // Wait for DB messages to load BEFORE clearing streaming state.
      // Otherwise StreamingMessage unmounts (isGenerating=false) before
      // the DB-fetched AssistantMessageGroup is ready, causing a flash
      // where the response text disappears.
      try {
        if (sessionId) {
          await finishFromDatabase(sessionId);
        }
      } finally {
        store.getState().finishGeneration();
        connectionStore.getState().setStatus("idle");
      }
      // Delayed verification refetch — catches any React rendering race condition
      // where the first refetch (before finishGeneration) returned stale data.
      // By the time the streaming fallback expires (800ms), this refetch will have
      // updated the React Query cache with the definitive DB content.
      const _sid = sessionId;
      if (_sid) {
        setTimeout(() => {
          queryClient.invalidateQueries({
            queryKey: queryKeys.messages.list(_sid),
          });
        }, 500);
      }

      // Refetch sessions to pick up the title (set synchronously before DONE now)
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      if (_sid) {
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(_sid) });
      }

      // Refresh billing balance from OpenYak proxy after each generation
      const auth = useAuthStore.getState();
      if (auth.isConnected) {
        proxyApi
          .get<{ credits: number; daily_free_tokens_used: number; daily_free_token_limit: number }>(
            "/api/billing/balance",
          )
          .then((balance) => {
            const currentUser = useAuthStore.getState().user;
            if (currentUser) {
              useAuthStore.getState().updateUser({
                ...currentUser,
                billing_mode:
                  balance.credits > 0 ? "credits" : currentUser.billing_mode,
                credit_balance: balance.credits,
                daily_free_tokens_used: balance.daily_free_tokens_used,
                daily_free_token_limit: balance.daily_free_token_limit,
              });
            }
          })
          .catch(() => {
            // Silently ignore balance refresh failures
          });
      }

      client.close();
    });

    // Agent error (business-level), not EventSource transport errors.
    const handleAgentError = async (data: { error_message?: string | null }, id: number) => {
      persistedLastEventId = id;
      const message = data.error_message ?? "Unknown stream error";
      const contextLimitError = /maximum context length|requested about/i.test(message);
      if (contextLimitError) {
        toast.error("Context too long for this model. Start a new chat or shorten the conversation.");
      } else {
        toast.error(message);
      }
      // Keep this as warn to avoid Next.js dev error overlay for expected business errors.
      console.warn("SSE agent error:", message);
      reasoningBuffer.flush();
      const sessionId = store.getState().sessionId;
      // Wait for DB messages (backend now persists partial text on error)
      // before clearing streaming state, same as DONE handler.
      try {
        if (sessionId) {
          await finishFromDatabase(sessionId);
        }
      } finally {
        store.getState().finishGeneration();
        connectionStore.getState().setStatus("idle");
      }
      // Delayed verification refetch (same as DONE handler)
      if (sessionId) {
        setTimeout(() => {
          queryClient.invalidateQueries({
            queryKey: queryKeys.messages.list(sessionId),
          });
        }, 500);
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
      }
      client.close();
    };

    client.on(SSE_EVENTS.AGENT_ERROR, handleAgentError);
    // Backward compatibility for older backend versions still emitting `error`.
    client.on(SSE_EVENTS.ERROR, handleAgentError);

      client.connect();
      clientRef.current = client;

      // Desktop: pause SSE reconnection while backend is restarting,
      // resume once it's ready. Prevents ERR_CONNECTION_REFUSED during the restart window.
      let unlistenRestarting: (() => void) | null = null;
      let unlistenRestarted: (() => void) | null = null;
      if (IS_DESKTOP) {
        unlistenRestarting = desktopAPI.onBackendRestarting(() => {
          clientRef.current?.pauseReconnect();
        });
        unlistenRestarted = desktopAPI.onBackendRestart(() => {
          clientRef.current?.resumeReconnect();
        });
      }

      // Idle recovery: if isGenerating is true but no SSE event has arrived
      // for a while, the stream is likely dead (both STEP_FINISH and DONE lost
      // due to queue overflow or network issues). Try DB recovery quickly so a
      // completed response does not leave the input disabled for a full minute.
      // finishFromDatabase() still checks /chat/active before clearing state.
      const IDLE_RECOVERY_MS = 15_000;
      const IDLE_CHECK_INTERVAL_MS = 5_000;
      const idleCheckTimer = setInterval(async () => {
        if (!store.getState().isGenerating) {
          clearInterval(idleCheckTimer);
          return;
        }
        if (lastEventTimestamp > 0 && Date.now() - lastEventTimestamp > IDLE_RECOVERY_MS) {
          console.warn("SSE idle recovery: no events for 15s, attempting DB recovery");
          const sid = store.getState().sessionId;
          if (sid) {
            const finished = await finishFromDatabase(sid);
            if (finished) {
              clearInterval(idleCheckTimer);
              client.close();
              return;
            }
          }
          lastEventTimestamp = Date.now();
          client.checkHealth();
        }
      }, IDLE_CHECK_INTERVAL_MS);

      // Visibility-aware SSE management.
      // Mobile (remote mode): pause SSE when hidden to save battery; resume on visible.
      // Desktop: just check health on visible (don't close the connection).
      let mobilePauseTimer: ReturnType<typeof setTimeout> | null = null;
      const handleVisibilityChange = () => {
        if (!clientRef.current || !store.getState().isGenerating) return;

        if (document.visibilityState === "visible") {
          // Came back — cancel pending pause and resume immediately.
          if (mobilePauseTimer) {
            clearTimeout(mobilePauseTimer);
            mobilePauseTimer = null;
          }
          clientRef.current.resumeReconnect();
          clientRef.current.checkHealth();
        } else if (isRemoteMode()) {
          // Mobile hidden — delay pause by 30s to keep streaming alive
          // during brief app switches. If the user returns within 30s,
          // the timer is cancelled and the SSE connection stays open.
          mobilePauseTimer = setTimeout(() => {
            clientRef.current?.pauseReconnect();
            mobilePauseTimer = null;
          }, 30_000);
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      cleanup = () => {
        clearInterval(idleCheckTimer);
        if (mobilePauseTimer) {
          clearTimeout(mobilePauseTimer);
          mobilePauseTimer = null;
        }
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        unlistenRestarting?.();
        unlistenRestarted?.();
        if (stepFinishTimer) {
          clearTimeout(stepFinishTimer);
          stepFinishTimer = null;
        }
        // Flush any pending reasoning text to the store before disposing,
        // so buffered content isn't lost during navigation.
        if (store.getState().isGenerating) {
          reasoningBuffer.flush();
        }
        reasoningBuffer.dispose();
        reasoningBufferRef.current = null;
        client.close();
        clientRef.current = null;
        if (store.getState().isGenerating) {
          // Reset module-level state so a future stream doesn't inherit stale values
          persistedLastEventId = 0;
          currentStreamId = null;
        } else {
          connectionStore.getState().setStatus("idle");
        }
      };
    };

    void start();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [streamId, queryClient, store, connectionStore]);

  return clientRef;
}
