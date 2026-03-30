"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useChat } from "@/hooks/use-chat";
import { useMessages } from "@/hooks/use-messages";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useChatStore } from "@/stores/chat-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { useActivityStore } from "@/stores/activity-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import { ChatHeader } from "./chat-header";
import { ChatForm } from "./chat-form";
import { MessageList } from "@/components/messages/message-list";
import { PermissionDialog } from "@/components/interactive/permission-dialog";
import { QuestionPrompt } from "@/components/interactive/question-prompt";
import { PlanAcceptPrompt } from "@/components/interactive/plan-accept-prompt";
import { OfflineOverlay } from "@/components/layout/offline-overlay";
import type { SessionResponse } from "@/types/session";

interface ChatViewProps {
  sessionId: string;
}

export function ChatView({ sessionId }: ChatViewProps) {
  const {
    sendMessage,
    editAndResend,
    stopGeneration,
    respondToPermission,
    respondToQuestion,
    respondToPlanReview,
    isGenerating,
    streamId,
    pendingUserText,
    pendingAttachments,
    streamingParts,
    streamingText,
    streamingReasoning,
    pendingPermission,
    pendingQuestion,
    pendingPlanReview,
  } = useChat(sessionId);

  // Ref to access latest stopGeneration in cleanup without re-triggering the effect
  const stopRef = useRef(stopGeneration);
  stopRef.current = stopGeneration;

  const { messages, isLoading, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage } = useMessages(sessionId);

  const { data: session } = useQuery({
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: () => api.get<SessionResponse>(API.SESSIONS.DETAIL(sessionId)),
    staleTime: 30_000,
  });

  // Auto-fix sessions with default title — set to first user message
  const qc = useQueryClient();
  useEffect(() => {
    if (!session || !messages || messages.length === 0) return;
    if (session.title && session.title !== "New Session") return;
    const firstUser = messages.find((m) => m.data?.role === "user");
    if (!firstUser) return;
    const textPart = firstUser.parts.find((p) => p.data?.type === "text");
    const text = (textPart?.data as any)?.text;
    if (!text) return;
    const title = text.trim().slice(0, 60);
    if (!title) return;
    api.patch(API.SESSIONS.DETAIL(sessionId), { title }).then(() => {
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all });
      qc.setQueryData<SessionResponse>(
        queryKeys.sessions.detail(sessionId),
        (old) => (old ? { ...old, title } : old),
      );
    }).catch(() => {});
  }, [session, messages, sessionId, qc]);

  // Close right-side panels when switching sessions; abort generation if active.
  // We use a ref to track whether we're truly leaving this session vs. React
  // Strict Mode's dev-only double-invoke (mount → unmount → remount).
  const sessionMountedRef = useRef(false);
  useEffect(() => {
    useArtifactStore.getState().clearAll();
    useActivityStore.getState().close();
    useWorkspaceStore.getState().resetForSession();

    // Sync workspace directory for MemoryBlock
    api.get<SessionResponse>(API.SESSIONS.DETAIL(sessionId)).then((s) => {
      if (s.directory) {
        useWorkspaceStore.getState().setActiveWorkspacePath(s.directory);
      }
    }).catch(() => {});

    // Load persisted todos and workspace files for this session
    api.get<{ todos: Array<{ content: string; status: string; activeForm?: string }> }>(
      API.SESSIONS.TODOS(sessionId),
    ).then((res) => {
      if (res.todos && res.todos.length > 0) {
        useWorkspaceStore.getState().setTodos(res.todos as any);
      }
    }).catch(() => {
      // Non-critical — todos may not exist yet
    });

    api.get<{ files: Array<{ name: string; path: string; type: string; tool: string }> }>(
      API.SESSIONS.FILES(sessionId),
    ).then((res) => {
      if (res.files && res.files.length > 0) {
        useWorkspaceStore.getState().setWorkspaceFiles(
          res.files.map((f) => ({ name: f.name, path: f.path, type: f.type as any })),
        );
      }
    }).catch(() => {
      // Non-critical — files may not exist yet
    });

    sessionMountedRef.current = true;
    return () => {
      // Defer the abort check to the next microtask. If this is a React Strict
      // Mode double-invoke, the component will remount synchronously and set
      // sessionMountedRef back to true before the microtask runs. If it's a
      // real unmount/session change, the ref stays false.
      sessionMountedRef.current = false;
      const capturedStopRef = stopRef.current;
      const capturedSessionId = sessionId;
      queueMicrotask(() => {
        if (sessionMountedRef.current) return; // StrictMode remount — skip abort
        const state = useChatStore.getState();
        if (state.isGenerating && state.sessionId === capturedSessionId) {
          capturedStopRef();
        }
      });
    };
  }, [sessionId]);

  // Copy last assistant message to clipboard
  const handleCopyLast = useCallback(() => {
    if (!messages || messages.length === 0) return;

    // Find last assistant message
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((msg) => (msg.data as { role: string }).role === "assistant");

    if (!lastAssistantMessage) {
      toast.error("No assistant message found");
      return;
    }

    // Extract text content
    const textContent = lastAssistantMessage.parts
      .filter((p) => p.data.type === "text")
      .map((p) => (p.data as { type: "text"; text: string }).text)
      .join("\n");

    if (!textContent) {
      toast.error("No text content to copy");
      return;
    }

    navigator.clipboard.writeText(textContent);
    toast.success("Copied to clipboard");
  }, [messages]);

  // Global keyboard shortcuts
  useKeyboardShortcuts({
    onStop: stopGeneration,
    onCopyLast: handleCopyLast,
  });

  return (
    <div className="relative flex flex-1 flex-col h-full overflow-hidden bg-[var(--surface-chat)]">
      <OfflineOverlay />
      <ChatHeader sessionId={sessionId} />

      {/* Message list */}
      <MessageList
        messages={messages}
        isLoading={isLoading}
        isGenerating={isGenerating}
        streamId={streamId}
        pendingUserText={pendingUserText}
        pendingAttachments={pendingAttachments}
        streamingParts={streamingParts}
        streamingText={streamingText}
        streamingReasoning={streamingReasoning}
        onEditAndResend={editAndResend}
        hasPreviousPage={hasPreviousPage}
        isFetchingPreviousPage={isFetchingPreviousPage}
        fetchPreviousPage={fetchPreviousPage}
      />

      {/* Interactive prompts */}
      {pendingPermission && (
        <PermissionDialog
          permission={pendingPermission}
          onRespond={respondToPermission}
        />
      )}

      {pendingQuestion && (
        <QuestionPrompt
          question={pendingQuestion}
          onRespond={respondToQuestion}
        />
      )}

      {/* Input — replaced by plan accept prompt when a plan review is pending */}
      {pendingPlanReview ? (
        <PlanAcceptPrompt onRespond={respondToPlanReview} />
      ) : (
        <ChatForm
          isGenerating={isGenerating}
          onSend={sendMessage}
          onStop={stopGeneration}
          sessionId={sessionId}
          directory={session?.directory}
        />
      )}
    </div>
  );
}
