"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import { getChatRoute } from "@/lib/routes";
import { useChatStore } from "@/stores/chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useActivityStore } from "@/stores/activity-store";
import { useSSE } from "./use-sse";
import { useRemoteGenerationSync } from "./use-remote-generation-sync";
import type { InfiniteData } from "@tanstack/react-query";
import type { FileAttachment, PromptResponse, RespondRequest } from "@/types/chat";
import type { PaginatedMessages } from "@/types/message";
import type { SessionResponse } from "@/types/session";

/**
 * Core chat hook — orchestrates the full prompt → stream → assemble cycle.
 */
export function useChat(currentSessionId?: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Subscribe only to the specific fields ChatView needs for rendering.
  // Avoid `useChatStore()` without a selector — it subscribes to the entire
  // store and causes re-renders on every streaming delta (~dozens/sec).
  const isGenerating = useChatStore((s) => s.isGenerating);
  const isCompacting = useChatStore((s) => s.isCompacting);
  const streamId = useChatStore((s) => s.streamId);
  const pendingUserText = useChatStore((s) => s.pendingUserText);
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const streamingParts = useChatStore((s) => s.streamingParts);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const pendingPermission = useChatStore((s) => s.pendingPermission);
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const pendingPlanReview = useChatStore((s) => s.pendingPlanReview);

  // SSE connection — activates when streamId is set
  useSSE(streamId);

  // Detect generations started by other clients (e.g., mobile)
  useRemoteGenerationSync(currentSessionId);

  const sendMessage = useCallback(
    async (text: string, attachments?: FileAttachment[]): Promise<boolean> => {
      // Read stores at call-time (not as reactive subscriptions) — this keeps
      // the callback reference stable so downstream components don't re-render.
      const chatState = useChatStore.getState();
      const settingsState = useSettingsStore.getState();

      if (chatState.isGenerating || chatState.isCompacting || (!text.trim() && (!attachments || attachments.length === 0))) return false;

      // New chat must start from a clean per-session state to avoid
      // leaking any transient stream/session context from previous chats.
      if (!currentSessionId) {
        chatState.reset();
      }

      // Starting a fresh generation invalidates any side panels that were
      // showing the previous assistant response.
      useActivityStore.getState().close();
      try {
        const { useArtifactStore } = require("@/stores/artifact-store");
        useArtifactStore.getState().close();
      } catch {}
      try {
        const { usePlanReviewStore } = require("@/stores/plan-review-store");
        usePlanReviewStore.getState().close();
      } catch {}

      // Show loading state + optimistic user bubble immediately
      chatState.beginSending(text.trim(), attachments);

      try {
        // Convert camelCase presets to snake_case keys for the backend
        const presets = settingsState.permissionPresets;
        const permissionPresets = {
          file_changes: presets.fileChanges,
          run_commands: presets.runCommands,
        };
        const hasActivePresets = Object.values(permissionPresets).some(Boolean);
        const permissionRules = settingsState.savedPermissions.map((rule) => ({
          action: rule.allow ? "allow" as const : "deny" as const,
          permission: rule.tool,
          pattern: "*",
        }));

        const res = await api.post<PromptResponse>(API.CHAT.PROMPT, {
          text: text.trim(),
          session_id: currentSessionId ?? null,
          model: settingsState.selectedModel,
          provider_id: settingsState.selectedProviderId,
          agent: settingsState.selectedAgent,
          attachments: attachments ?? [],
          permission_presets: hasActivePresets ? permissionPresets : null,
          permission_rules: permissionRules.length > 0 ? permissionRules : null,
          reasoning: settingsState.reasoningEnabled,
          workspace: settingsState.workspaceDirectory,
        });

        chatState.startGeneration(res.stream_id, res.session_id);

        // Don't refetch messages here — the optimistic pendingUserText bubble
        // stays visible during streaming. A mid-stream refetch can return
        // partially-populated assistant messages that duplicate the StreamingMessage.
        // Messages are refetched after DONE in the SSE handler.

        // Navigate to session if this was a new conversation
        if (!currentSessionId) {
          // Optimistically add the session to the sidebar with user text as temp title
          const tempSession: SessionResponse = {
            id: res.session_id,
            project_id: null,
            parent_id: null,
            slug: null,
            directory: settingsState.workspaceDirectory || null,
            title: text.trim().slice(0, 60),
            version: 0,
            summary_additions: 0,
            summary_deletions: 0,
            summary_files: 0,
            summary_diffs: [],
            is_pinned: false,
            permission: {},
            time_created: new Date().toISOString(),
            time_updated: new Date().toISOString(),
            time_compacting: null,
            time_archived: null,
          };
          queryClient.setQueryData<InfiniteData<SessionResponse[]>>(
            queryKeys.sessions.all,
            (old) => {
              if (!old) return { pages: [[tempSession]], pageParams: [0] };
              return {
                ...old,
                pages: [[tempSession, ...old.pages[0]], ...old.pages.slice(1)],
              };
            },
          );
          router.push(getChatRoute(res.session_id));
        }
        return true;
      } catch (err) {
        console.error("Failed to start generation:", err);
        useChatStore.getState().reset();
        toast.error("Failed to send message", { duration: 8000 });
        return false;
      }
    },
    [currentSessionId, router, queryClient],
  );

  const stopGeneration = useCallback(async () => {
    const { streamId, sessionId, finishGeneration } = useChatStore.getState();
    if (!streamId) return;
    try {
      await api.post(API.CHAT.ABORT, { stream_id: streamId });
    } catch (err) {
      console.error("Failed to abort — backend may still be generating:", err);
    }
    // Clean up frontend state immediately — don't wait for backend DONE event
    // (the backend may delay DONE while running post-generation tasks like title generation)
    finishGeneration();
    // Stop workspace progress spinners — mark in_progress todos as pending
    const ws = useWorkspaceStore.getState();
    if (ws.todos.some((t) => t.status === "in_progress")) {
      ws.setTodos(
        ws.todos.map((t) =>
          t.status === "in_progress" ? { ...t, status: "pending" as const, activeForm: undefined } : t,
        ),
      );
    }
    if (sessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.list(sessionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
  }, [queryClient]);

  const respondToPermission = useCallback(
    async (allow: boolean, remember = false) => {
      const { pendingPermission: perm, streamId, clearPermissionRequest, setPermissionRequest } = useChatStore.getState();
      if (!perm || !streamId) return;

      const req: RespondRequest = {
        stream_id: streamId,
        call_id: perm.callId,
        response: {
          allowed: allow,
          remember,
          permission: perm.tool || perm.permission,
          pattern: perm.patterns[0] ?? "*",
        },
      };

      try {
        clearPermissionRequest();
        await api.post(API.CHAT.RESPOND, req);
      } catch (err) {
        setPermissionRequest(perm);
        console.error("Failed to respond to permission:", err);
        toast.error("Failed to respond");
      }
    },
    [],
  );

  const editAndResend = useCallback(
    async (messageId: string, newText: string, attachments?: FileAttachment[]): Promise<boolean> => {
      const chatState = useChatStore.getState();
      const settingsState = useSettingsStore.getState();

      if (chatState.isGenerating || chatState.isCompacting || (!newText.trim() && (!attachments || attachments.length === 0)) || !currentSessionId) return false;

      // Close any panels bound to the previous assistant response so resend
      // doesn't keep showing stale "done" activity while the new run is live.
      useActivityStore.getState().close();
      try {
        const { useArtifactStore } = require("@/stores/artifact-store");
        useArtifactStore.getState().close();
      } catch {}
      try {
        const { usePlanReviewStore } = require("@/stores/plan-review-store");
        usePlanReviewStore.getState().close();
      } catch {}

      chatState.beginSending(newText.trim(), attachments);

      try {
        const presets = settingsState.permissionPresets;
        const permissionPresets = {
          file_changes: presets.fileChanges,
          run_commands: presets.runCommands,
        };
        const hasActivePresets = Object.values(permissionPresets).some(Boolean);
        const permissionRules = settingsState.savedPermissions.map((rule) => ({
          action: rule.allow ? "allow" as const : "deny" as const,
          permission: rule.tool,
          pattern: "*",
        }));

        const res = await api.post<PromptResponse>(API.CHAT.EDIT, {
          session_id: currentSessionId,
          message_id: messageId,
          text: newText.trim(),
          model: settingsState.selectedModel,
          provider_id: settingsState.selectedProviderId,
          agent: settingsState.selectedAgent,
          attachments: attachments ?? [],
          permission_presets: hasActivePresets ? permissionPresets : null,
          permission_rules: permissionRules.length > 0 ? permissionRules : null,
          reasoning: settingsState.reasoningEnabled,
          workspace: settingsState.workspaceDirectory,
        });

        chatState.startGeneration(res.stream_id, res.session_id);

        // Reset workspace sidebar — old progress/files are stale after resend
        useWorkspaceStore.getState().setTodos([]);
        useWorkspaceStore.getState().setWorkspaceFiles([]);

        // Optimistically trim cached messages: the backend already deleted
        // everything after the edited message and updated its text.
        const trimmed = newText.trim();
        queryClient.setQueryData<InfiniteData<PaginatedMessages>>(
          queryKeys.messages.list(currentSessionId),
          (old) => {
            if (!old) return old;
            // Find which page contains the edited message and trim
            const newPages = old.pages.map((page) => {
              const idx = page.messages.findIndex((m) => m.id === messageId);
              if (idx === -1) return page;
              return {
                ...page,
                messages: page.messages.slice(0, idx + 1).map((m, i) => {
                  if (i !== idx) return m;
                  return {
                    ...m,
                    parts: m.parts.map((p) =>
                      p.data.type === "text"
                        ? { ...p, data: { ...p.data, text: trimmed } }
                        : p,
                    ),
                  };
                }),
              };
            });
            // Remove pages after the one containing the edited message
            const pageIdx = newPages.findIndex((p) =>
              p.messages.some((m) => m.id === messageId),
            );
            return {
              ...old,
              pages: pageIdx >= 0 ? newPages.slice(0, pageIdx + 1) : newPages,
              pageParams: pageIdx >= 0 ? old.pageParams.slice(0, pageIdx + 1) : old.pageParams,
            };
          },
        );
        // No pending bubble needed — the edited message is already in the cache
        useChatStore.setState({ pendingUserText: null });

        return true;
      } catch (err) {
        console.error("Failed to edit and resend:", err);
        useChatStore.getState().reset();
        toast.error("Failed to edit message");
        return false;
      }
    },
    [currentSessionId, queryClient],
  );

  const respondToQuestion = useCallback(
    async (answer: string | Record<string, string>) => {
      const { pendingQuestion: question, streamId, clearQuestion } = useChatStore.getState();
      if (!question || !streamId) return;

      // Multi-question mode: answer is Record<string, string>, serialize to JSON
      // Legacy mode: answer is a plain string
      const response =
        typeof answer === "string" ? answer.trim() : JSON.stringify(answer);
      if (!response) return;

      const req: RespondRequest = {
        stream_id: streamId,
        call_id: question.callId,
        response,
      };

      try {
        await api.post(API.CHAT.RESPOND, req);
        clearQuestion();
      } catch (err) {
        console.error("Failed to respond to question:", err);
        toast.error("Failed to respond");
      }
    },
    [],
  );

  const respondToPlanReview = useCallback(
    async (action: "accept" | "revise" | "stop", options?: { mode?: "auto" | "ask"; feedback?: string }) => {
      const { pendingPlanReview: review, streamId, clearPlanReview } = useChatStore.getState();
      if (!review || !streamId) return;

      let response: Record<string, string>;
      if (action === "accept") {
        response = { action: "accept", mode: options?.mode ?? "auto" };
      } else if (action === "stop") {
        response = { action: "stop" };
      } else {
        response = { action: "revise", feedback: options?.feedback ?? "" };
      }

      const req: RespondRequest = {
        stream_id: streamId,
        call_id: review.callId,
        response: JSON.stringify(response),
      };

      try {
        await api.post(API.CHAT.RESPOND, req);
        clearPlanReview();

        if (action === "accept") {
          // Close panel and switch work mode
          try {
            const { usePlanReviewStore } = require("@/stores/plan-review-store");
            usePlanReviewStore.getState().close();
          } catch {}
          useSettingsStore.getState().setWorkMode(options?.mode ?? "auto");
        }
        // For "stop": panel stays open with current plan data (plan is also saved to disk).
        //   Note: opening an artifact/activity panel will close the plan panel via mutual exclusion.
        // For "revise": panel stays open, AI will revise and call submit_plan again.
      } catch (err) {
        console.error("Failed to respond to plan review:", err);
        toast.error("Failed to respond");
      }
    },
    [],
  );

  return {
    sendMessage,
    editAndResend,
    stopGeneration,
    respondToPermission,
    respondToQuestion,
    respondToPlanReview,
    isGenerating,
    isCompacting,
    streamId,
    pendingUserText,
    pendingAttachments,
    streamingParts,
    streamingText,
    streamingReasoning,
    pendingPermission,
    pendingQuestion,
    pendingPlanReview,
  };
}
