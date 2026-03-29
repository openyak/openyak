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
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useAuthStore } from "@/stores/auth-store";
import { proxyApi } from "@/lib/proxy-api";
import { api } from "@/lib/api";
import { isPreviewableFile, artifactTypeFromExtension, languageFromExtension } from "@/lib/artifacts";
import type { SessionResponse } from "@/types/session";
import type { ArtifactType } from "@/types/artifact";

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
  private rafId: number | null = null;
  private lastTickAt = 0;
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
    if (!this.rafId) this.tick();
  }

  flush() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pending) {
      this.appendFn(this.pending);
      this.pending = "";
    }
  }

  dispose() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pending = "";
  }

  private tick = () => {
    if (!this.pending) {
      this.rafId = null;
      return;
    }
    const now = performance.now();
    const elapsed = now - this.lastTickAt;
    if (elapsed < PROGRESSIVE_BUFFER_INTERVAL_MS && this.lastTickAt > 0) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.lastTickAt = now;
    const chunk = this.pending.slice(0, this.charsPerFrame);
    this.pending = this.pending.slice(this.charsPerFrame);
    this.appendFn(chunk);
    this.rafId = requestAnimationFrame(this.tick);
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

      const reasoningBuffer = new ProgressiveBuffer((text) => {
        store.getState().appendReasoningDelta(text);
      });
      reasoningBufferRef.current = reasoningBuffer;

      const client = new SSEClient({
        url: API.CHAT.STREAM(streamId),
        // Re-resolve URL on each reconnect so port changes (backend restart) are picked up
        urlProvider: () => API.CHAT.STREAM(streamId),
        initialLastEventId: persistedLastEventId,
        onEvent: () => {
          lastEventTimestamp = Date.now();
        },
        onStatusChange: (status) => {
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
                  await queryClient.invalidateQueries({
                    queryKey: queryKeys.messages.list(sessionId),
                  });
                  await new Promise<void>((r) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => r())),
                  );
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

    // Text streaming
    client.on(SSE_EVENTS.TEXT_DELTA, (data, id) => {
      persistedLastEventId = id;
      if (store.getState().isModelLoading) store.getState().setModelLoading(false);
      if (data.text) store.getState().appendTextDelta(data.text);
    });

    client.on(SSE_EVENTS.REASONING_DELTA, (data, id) => {
      persistedLastEventId = id;
      if (data.text) reasoningBuffer.push(data.text);
    });

    // Tool lifecycle
    client.on(SSE_EVENTS.TOOL_START, (data, id) => {
      persistedLastEventId = id;
      if (data.tool && data.call_id) {
        store.getState().addToolStart(
          data.tool,
          data.call_id,
          data.arguments ?? {},
          data.title,
        );

        // Auto-open artifact panel when the artifact tool is called
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

        // Auto-open artifact panel when write tool creates a previewable file
        if (data.tool === "write" && data.arguments) {
          const args = data.arguments as Record<string, string>;
          const filePath = args.file_path;
          if (filePath && isPreviewableFile(filePath) && args.content) {
            const type = artifactTypeFromExtension(filePath) ?? "code";
            const fileName = filePath.split(/[\\/]/).pop() || "File Preview";
            useArtifactStore.getState().openArtifact({
              id: `file-${data.call_id}`,
              type: type === "file-preview" ? "code" : type,
              title: fileName,
              content: args.content,
              language: languageFromExtension(filePath),
              filePath,
            });
          }
        }

      }
    });

    client.on(SSE_EVENTS.TOOL_RESULT, (data, id) => {
      persistedLastEventId = id;
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
            useWorkspaceStore.getState().setTodos(meta.todos as any);
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
                  res.files.map((f) => ({ name: f.name, path: f.path, type: f.type as any })),
                );
              }
            }).catch(() => {});
          }
        }

        // Refresh workspace memory after memory tool calls
        if (data.tool === "memory") {
          const workspacePath = useWorkspaceStore.getState().activeWorkspacePath;
          if (workspacePath) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.workspaceMemory(workspacePath),
            });
            queryClient.invalidateQueries({
              queryKey: queryKeys.workspaceMemoryList,
            });
          }
        }

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
      if (data.call_id) {
        store.getState().setToolError(data.call_id, data.output ?? data.error_message ?? "Error");
      }
    });

    // Step lifecycle
    client.on(SSE_EVENTS.STEP_START, (data, id) => {
      persistedLastEventId = id;
      store.getState().addStepStart(data.step ?? 0);
    });

    // Safety net: if the agent loop finished (terminal step_finish) but DONE
    // never arrives (e.g., lost due to network issues), force-finish after 30s.
    let stepFinishTimer: ReturnType<typeof setTimeout> | null = null;

    client.on(SSE_EVENTS.STEP_FINISH, (data, id) => {
      persistedLastEventId = id;
      store.getState().addStepFinish(
        data.reason ?? "stop",
        data.tokens ?? {},
        data.cost ?? 0,
      );

      // Terminal step_finish (not tool_use/tool_calls) means the agent loop is done.
      // Start a safety timer in case DONE is never received.
      const isToolStep = data.reason === "tool_use" || data.reason === "tool_calls";
      if (data.reason && !isToolStep) {
        if (stepFinishTimer) clearTimeout(stepFinishTimer);
        stepFinishTimer = setTimeout(async () => {
          if (store.getState().isGenerating) {
            console.warn("SSE safety net: forcing finishGeneration after step_finish timeout");
            reasoningBuffer.flush();
            const sid = store.getState().sessionId;
            // Refetch DB messages BEFORE clearing streaming state,
            // matching the DONE handler pattern. Otherwise the response
            // appears blank until the next refetch cycle.
            try {
              if (sid) {
                await queryClient.invalidateQueries({
                  queryKey: queryKeys.messages.list(sid),
                });
                await new Promise<void>((r) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => r())),
                );
              }
            } finally {
              store.getState().finishGeneration();
              connectionStore.getState().setStatus("idle");
            }
            client.close();
          }
        }, 30_000);
      } else {
        // Non-terminal step (tool_use) — clear any pending safety timer
        if (stepFinishTimer) {
          clearTimeout(stepFinishTimer);
          stepFinishTimer = null;
        }
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

    client.on(SSE_EVENTS.COMPACTED, (_data, id) => {
      persistedLastEventId = id;
      store.getState().addCompaction(true);
    });

    // Interactive: Permission
    client.on(SSE_EVENTS.PERMISSION_REQUEST, (data, id) => {
      persistedLastEventId = id;
      if (data.call_id) {
        store.getState().setPermissionRequest({
          callId: data.call_id,
          tool: data.tool ?? "",
          permission: data.permission ?? "",
          patterns: data.patterns ?? [],
        });
      }
    });

    // Interactive: Question
    client.on(SSE_EVENTS.QUESTION, (data, id) => {
      persistedLastEventId = id;
      if (data.call_id) {
        store.getState().setQuestion({
          callId: data.call_id,
          tool: data.tool ?? "question",
          arguments: data.arguments ?? { question: data.question, options: data.options, questions: data.questions },
        });
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
    // Clear stale streaming state, then refetch messages from DB.
    client.on(SSE_EVENTS.DESYNC, (_data, id) => {
      persistedLastEventId = id;
      store.getState().clearStreamingContent();
      const sessionId = store.getState().sessionId;
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
      }
    });

    client.on(SSE_EVENTS.COMPACTION_ERROR, () => {
      toast.warning("Context compression failed. Consider starting a new chat.");
    });

    // Completion
    client.on(SSE_EVENTS.DONE, async (_data, id) => {
      persistedLastEventId = id;
      if (stepFinishTimer) {
        clearTimeout(stepFinishTimer);
        stepFinishTimer = null;
      }
      reasoningBuffer.flush();
      const sessionId = store.getState().sessionId;

      // Wait for DB messages to load BEFORE clearing streaming state.
      // Otherwise StreamingMessage unmounts (isGenerating=false) before
      // the DB-fetched AssistantMessageGroup is ready, causing a flash
      // where the response text disappears.
      try {
        if (sessionId) {
          await queryClient.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
          // Let React render the refetched DB messages before unmounting
          // StreamingMessage. Without this double-rAF, there's a 1-frame
          // gap where neither the streaming component nor the DB-fetched
          // component is visible, producing a blank flash.
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          );
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
          await queryClient.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          );
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
      // in 60 seconds, the stream is likely dead (both STEP_FINISH and DONE
      // lost due to queue overflow or network issues). Force recovery by
      // refetching from DB and clearing streaming state.
      const IDLE_RECOVERY_MS = 60_000;
      const IDLE_CHECK_INTERVAL_MS = 15_000;
      const idleCheckTimer = setInterval(async () => {
        if (!store.getState().isGenerating) {
          clearInterval(idleCheckTimer);
          return;
        }
        if (lastEventTimestamp > 0 && Date.now() - lastEventTimestamp > IDLE_RECOVERY_MS) {
          console.warn("SSE idle recovery: no events for 60s, forcing finishGeneration");
          clearInterval(idleCheckTimer);
          reasoningBuffer.flush();
          const sid = store.getState().sessionId;
          try {
            if (sid) {
              await queryClient.invalidateQueries({
                queryKey: queryKeys.messages.list(sid),
              });
              await new Promise<void>((r) =>
                requestAnimationFrame(() => requestAnimationFrame(() => r())),
              );
            }
          } finally {
            store.getState().finishGeneration();
            connectionStore.getState().setStatus("idle");
          }
          client.close();
        }
      }, IDLE_CHECK_INTERVAL_MS);

      // Visibility-aware SSE management.
      // Mobile (remote mode): pause SSE when hidden to save battery; resume on visible.
      // Desktop: just check health on visible (don't close the connection).
      const handleVisibilityChange = () => {
        if (!clientRef.current || !store.getState().isGenerating) return;

        if (document.visibilityState === "visible") {
          // Came back — resume if paused and check health immediately.
          clientRef.current.resumeReconnect();
          clientRef.current.checkHealth();
        } else if (isRemoteMode()) {
          // Mobile hidden — pause reconnection to save battery.
          // pauseReconnect() closes the EventSource, so only do this in
          // remote mode where battery matters more than background updates.
          clientRef.current.pauseReconnect();
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      cleanup = () => {
        clearInterval(idleCheckTimer);
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
