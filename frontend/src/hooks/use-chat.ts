"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import { getChatRoute } from "@/lib/routes";
import { useChatStore, useChatSession } from "@/stores/chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useActivityStore } from "@/stores/activity-store";
import { startStream, stopStream } from "@/lib/session-stream-registry";
import { useRemoteGenerationSync } from "./use-remote-generation-sync";
import type { InfiniteData } from "@tanstack/react-query";
import type { FileAttachment, PromptResponse, RespondRequest, TaskBatchRequest } from "@/types/chat";
import type { PaginatedMessages } from "@/types/message";
import type { SessionResponse } from "@/types/session";
import type { ModelInfo } from "@/types/model";

const MODEL_DOES_NOT_SUPPORT_IMAGES = "MODEL_DOES_NOT_SUPPORT_IMAGES";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VISION_MODEL_REQUIRED_MESSAGE = "The selected model does not support images. Choose a vision model and try again.";

function isImageAttachment(attachment: FileAttachment): boolean {
  if (attachment.mime_type?.startsWith("image/")) return true;
  const source = attachment.name || attachment.path || "";
  const dot = source.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(source.slice(dot).toLowerCase());
}

export function hasImageAttachments(attachments?: FileAttachment[]): boolean {
  return !!attachments?.some(isImageAttachment);
}

export function selectedModelSupportsVision(
  models: ModelInfo[] | undefined,
  modelId: string | null,
  providerId: string | null,
): boolean {
  if (!modelId || !models) return false;
  const selected =
    models.find((model) => model.id === modelId && (!providerId || model.provider_id === providerId)) ??
    models.find((model) => model.id === modelId);
  return selected?.capabilities.vision === true;
}

function isUnsupportedImagesError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const detail = (err.body as { detail?: unknown } | undefined)?.detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { code?: unknown }).code === MODEL_DOES_NOT_SUPPORT_IMAGES
  );
}

function formatTaskBatchPrompt(batch: Pick<TaskBatchRequest, "mode" | "tasks">): string {
  const heading = batch.mode === "parallel" ? "Run tasks in parallel" : "Run tasks sequentially";
  const lines = batch.tasks.map((task, index) => `${index + 1}. ${task.title}`);
  return [heading, ...lines].join("\n");
}

/**
 * Core chat hook — orchestrates the prompt → stream → assemble cycle for one
 * session. When called from Landing without a sessionId, all state lives in
 * the draft bucket until the backend assigns an id; from then on the keyed
 * bucket takes over and the actual SSE stream is owned by the
 * SessionStreamRegistry, not by this hook.
 */
export function useChat(currentSessionId?: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  // One subscription, one selector — re-renders only when the bucket reference
  // changes (i.e. when this session's state mutates).
  const session = useChatSession(currentSessionId ?? null);

  // Polling sync for streams started by other clients (e.g. mobile)
  useRemoteGenerationSync(currentSessionId);

  const sendMessage = useCallback(
    async (text: string, attachments?: FileAttachment[]): Promise<boolean> => {
      const chatState = useChatStore.getState();
      const settingsState = useSettingsStore.getState();
      const targetSessionId = currentSessionId ?? null;
      const currentBucket = targetSessionId === null
        ? chatState.draftSession
        : chatState.sessions[targetSessionId];

      if (currentBucket?.isGenerating || currentBucket?.isCompacting || (!text.trim() && (!attachments || attachments.length === 0))) {
        return false;
      }
      if (
        hasImageAttachments(attachments) &&
        !selectedModelSupportsVision(
          queryClient.getQueryData<ModelInfo[]>(queryKeys.models),
          settingsState.selectedModel,
          settingsState.selectedProviderId,
        )
      ) {
        toast.error(VISION_MODEL_REQUIRED_MESSAGE);
        return false;
      }

      // New chat must start from a clean draft.
      if (!currentSessionId) {
        chatState.resetSession(null);
      }

      // Starting a fresh generation invalidates any side panels showing the
      // previous assistant response.
      useActivityStore.getState().close();
      try {
        const { useArtifactStore } = require("@/stores/artifact-store");
        useArtifactStore.getState().close();
      } catch {}
      try {
        const { usePlanReviewStore } = require("@/stores/plan-review-store");
        usePlanReviewStore.getState().close();
      } catch {}

      chatState.beginSending(targetSessionId, text.trim(), attachments);

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

        // Seed the keyed bucket (carries over the draft contents if any) and
        // attach the SSE stream. Order matters: store update first so the
        // registry's handlers see a bucket they can write into.
        chatState.startGeneration(res.session_id, res.stream_id);
        void startStream(res.session_id, res.stream_id);

        if (!currentSessionId) {
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
            model_id: settingsState.selectedModel,
            provider_id: settingsState.selectedProviderId,
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
        chatState.resetSession(targetSessionId);

        if (err instanceof ApiError) {
          if (isUnsupportedImagesError(err)) {
            toast.error(VISION_MODEL_REQUIRED_MESSAGE);
            return false;
          }
          toast.error(err.message, { duration: 8000 });
          return false;
        }

        toast.error("Failed to send message", { duration: 8000 });
        return false;
      }
    },
    [currentSessionId, router, queryClient],
  );

  const sendTaskBatch = useCallback(
    async (batch: Pick<TaskBatchRequest, "mode" | "tasks">): Promise<boolean> => {
      const chatState = useChatStore.getState();
      const settingsState = useSettingsStore.getState();
      const targetSessionId = currentSessionId ?? null;
      const currentBucket = targetSessionId === null
        ? chatState.draftSession
        : chatState.sessions[targetSessionId];

      const tasks = batch.tasks
        .map((task) => ({
          ...task,
          title: task.title.trim(),
          prompt: task.prompt.trim(),
          agent: task.agent || settingsState.selectedAgent,
          model: task.model || settingsState.selectedModel,
          provider_id: task.provider_id || settingsState.selectedProviderId,
        }))
        .filter((task) => task.title && task.prompt);

      if (currentBucket?.isGenerating || currentBucket?.isCompacting || tasks.length === 0) return false;

      if (!currentSessionId) {
        chatState.resetSession(null);
      }

      useActivityStore.getState().close();
      try {
        const { useArtifactStore } = require("@/stores/artifact-store");
        useArtifactStore.getState().close();
      } catch {}
      try {
        const { usePlanReviewStore } = require("@/stores/plan-review-store");
        usePlanReviewStore.getState().close();
      } catch {}

      const optimisticText = formatTaskBatchPrompt({ mode: batch.mode, tasks });
      chatState.beginSending(targetSessionId, optimisticText);

      try {
        const res = await api.post<PromptResponse>(API.CHAT.TASK_BATCH, {
          session_id: currentSessionId ?? null,
          mode: batch.mode,
          tasks,
          workspace: settingsState.workspaceDirectory,
        });

        chatState.startGeneration(res.session_id, res.stream_id);
        void startStream(res.session_id, res.stream_id);

        if (!currentSessionId) {
          const tempSession: SessionResponse = {
            id: res.session_id,
            project_id: null,
            parent_id: null,
            slug: null,
            directory: settingsState.workspaceDirectory || null,
            title: tasks[0]?.title?.slice(0, 60) || "Multi-agent task batch",
            version: 0,
            summary_additions: 0,
            summary_deletions: 0,
            summary_files: 0,
            summary_diffs: [],
            is_pinned: false,
            permission: {},
            model_id: settingsState.selectedModel,
            provider_id: settingsState.selectedProviderId,
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
        console.error("Failed to start task batch:", err);
        chatState.resetSession(targetSessionId);

        if (err instanceof ApiError) {
          toast.error(err.message, { duration: 8000 });
          return false;
        }

        toast.error("Failed to start task batch", { duration: 8000 });
        return false;
      }
    },
    [currentSessionId, router, queryClient],
  );

  const stopGeneration = useCallback(async () => {
    const chatState = useChatStore.getState();
    const targetSessionId = currentSessionId ?? null;
    const bucket = targetSessionId === null
      ? chatState.draftSession
      : chatState.sessions[targetSessionId];
    const streamId = bucket?.streamId;
    if (!streamId) return;
    try {
      await api.post(API.CHAT.ABORT, { stream_id: streamId });
    } catch (err) {
      console.error("Failed to abort — backend may still be generating:", err);
    }
    // Stop the SSE stream and clear local state immediately — don't wait for
    // backend DONE (backend may delay DONE while doing post-generation work
    // like title generation).
    if (targetSessionId !== null) stopStream(targetSessionId);
    chatState.finishGeneration(targetSessionId);

    const ws = useWorkspaceStore.getState();
    if (ws.todos.some((t) => t.status === "in_progress")) {
      ws.setTodos(
        ws.todos.map((t) =>
          t.status === "in_progress" ? { ...t, status: "pending" as const, activeForm: undefined } : t,
        ),
      );
    }
    if (targetSessionId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.list(targetSessionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(targetSessionId) });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
  }, [currentSessionId, queryClient]);

  const respondToPermission = useCallback(
    async (allow: boolean, remember = false) => {
      const chatState = useChatStore.getState();
      const targetSessionId = currentSessionId ?? null;
      const bucket = targetSessionId === null
        ? chatState.draftSession
        : chatState.sessions[targetSessionId];
      const perm = bucket?.pendingPermission;
      const streamId = bucket?.streamId;
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
        chatState.clearPermissionRequest(targetSessionId);
        await api.post(API.CHAT.RESPOND, req);
      } catch (err) {
        chatState.setPermissionRequest(targetSessionId, perm);
        console.error("Failed to respond to permission:", err);
        toast.error("Failed to respond");
      }
    },
    [currentSessionId],
  );

  const editAndResend = useCallback(
    async (messageId: string, newText: string, attachments?: FileAttachment[]): Promise<boolean> => {
      const chatState = useChatStore.getState();
      const settingsState = useSettingsStore.getState();
      const bucket = currentSessionId ? chatState.sessions[currentSessionId] : null;

      if (bucket?.isGenerating || bucket?.isCompacting || (!newText.trim() && (!attachments || attachments.length === 0)) || !currentSessionId) return false;
      if (
        hasImageAttachments(attachments) &&
        !selectedModelSupportsVision(
          queryClient.getQueryData<ModelInfo[]>(queryKeys.models),
          settingsState.selectedModel,
          settingsState.selectedProviderId,
        )
      ) {
        toast.error(VISION_MODEL_REQUIRED_MESSAGE);
        return false;
      }

      useActivityStore.getState().close();
      try {
        const { useArtifactStore } = require("@/stores/artifact-store");
        useArtifactStore.getState().close();
      } catch {}
      try {
        const { usePlanReviewStore } = require("@/stores/plan-review-store");
        usePlanReviewStore.getState().close();
      } catch {}

      chatState.beginSending(currentSessionId, newText.trim(), attachments);

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

        chatState.startGeneration(res.session_id, res.stream_id);
        void startStream(res.session_id, res.stream_id);

        useWorkspaceStore.getState().setTodos([]);
        useWorkspaceStore.getState().setWorkspaceFiles([]);

        const trimmed = newText.trim();
        queryClient.setQueryData<InfiniteData<PaginatedMessages>>(
          queryKeys.messages.list(currentSessionId),
          (old) => {
            if (!old) return old;
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
        // No pending bubble needed — the edited message is already in cache.
        // Clear it explicitly on this session's bucket.
        useChatStore.setState((s) => {
          const cur = s.sessions[currentSessionId];
          if (!cur) return s;
          return {
            sessions: {
              ...s.sessions,
              [currentSessionId]: { ...cur, pendingUserText: null, pendingAttachments: null },
            },
          };
        });

        return true;
      } catch (err) {
        console.error("Failed to edit and resend:", err);
        chatState.resetSession(currentSessionId);

        if (err instanceof ApiError) {
          if (isUnsupportedImagesError(err)) {
            toast.error(VISION_MODEL_REQUIRED_MESSAGE);
            return false;
          }
          toast.error(err.message);
          return false;
        }

        toast.error("Failed to edit message");
        return false;
      }
    },
    [currentSessionId, queryClient],
  );

  const respondToQuestion = useCallback(
    async (answer: string | Record<string, string>) => {
      const chatState = useChatStore.getState();
      const targetSessionId = currentSessionId ?? null;
      const bucket = targetSessionId === null
        ? chatState.draftSession
        : chatState.sessions[targetSessionId];
      const question = bucket?.pendingQuestion;
      const streamId = bucket?.streamId;
      if (!question || !streamId) return;

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
        chatState.clearQuestion(targetSessionId);
      } catch (err) {
        console.error("Failed to respond to question:", err);
        toast.error("Failed to respond");
      }
    },
    [currentSessionId],
  );

  const respondToPlanReview = useCallback(
    async (action: "accept" | "revise" | "stop", options?: { mode?: "auto" | "ask"; feedback?: string }) => {
      const chatState = useChatStore.getState();
      const targetSessionId = currentSessionId ?? null;
      const bucket = targetSessionId === null
        ? chatState.draftSession
        : chatState.sessions[targetSessionId];
      const review = bucket?.pendingPlanReview;
      const streamId = bucket?.streamId;
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
        chatState.clearPlanReview(targetSessionId);

        if (action === "accept") {
          try {
            const { usePlanReviewStore } = require("@/stores/plan-review-store");
            usePlanReviewStore.getState().close();
          } catch {}
          useSettingsStore.getState().setWorkMode(options?.mode ?? "auto");
        }
      } catch (err) {
        console.error("Failed to respond to plan review:", err);
        toast.error("Failed to respond");
      }
    },
    [currentSessionId],
  );

  return {
    sendMessage,
    sendTaskBatch,
    editAndResend,
    stopGeneration,
    respondToPermission,
    respondToQuestion,
    respondToPlanReview,
    isGenerating: session.isGenerating,
    isCompacting: session.isCompacting,
    streamId: session.streamId,
    pendingUserText: session.pendingUserText,
    pendingAttachments: session.pendingAttachments,
    streamingParts: session.streamingParts,
    streamingText: session.streamingText,
    streamingReasoning: session.streamingReasoning,
    pendingPermission: session.pendingPermission,
    pendingQuestion: session.pendingQuestion,
    pendingPlanReview: session.pendingPlanReview,
  };
}
