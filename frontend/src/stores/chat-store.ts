"use client";

import { create } from "zustand";
import type { CompactionPart, CompactionPhase, CompactionPhaseStatus, PartData, ToolPart } from "@/types/message";
import type { PermissionRequest, QuestionRequest, PlanReviewRequest } from "@/types/streaming";
import type { FileAttachment } from "@/types/chat";

/**
 * Cumulative usage for the current chat session (across multiple generations).
 * Reset only on `reset()` (e.g., switching chats); preserved across `finishGeneration`.
 *
 * - `cost` mirrors the backend-authoritative `total_cost` from the latest step_finish.
 *   `null` when running on a model with no pricing (local Ollama, custom endpoints).
 * - Token fields are accumulated frontend-side from `step_finish.tokens`.
 *   Will reset on page refresh until Phase 2 wires backend persistence.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
}

const EMPTY_SESSION_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: null,
};

interface ChatStore {
  // ─── Active generation ───
  streamId: string | null;
  sessionId: string | null;
  isGenerating: boolean;
  isCompacting: boolean;

  // ─── Optimistic user message ───
  /** Text shown as a pending user bubble before the API confirms creation. */
  pendingUserText: string | null;
  /** Attachments shown in the pending user bubble (cleared on startGeneration). */
  pendingAttachments: FileAttachment[] | null;

  // ─── Streaming message assembly ───
  /** Accumulated parts for the current assistant message. */
  streamingParts: PartData[];
  /** Current text_delta buffer (flushed into a TextPart on step_finish or done). */
  streamingText: string;
  /** Current reasoning_delta buffer. */
  streamingReasoning: string;

  // ─── Model loading (Ollama cold start) ───
  isModelLoading: boolean;

  // ─── Interactive prompts ───
  pendingPermission: PermissionRequest | null;
  pendingQuestion: QuestionRequest | null;
  pendingPlanReview: PlanReviewRequest | null;

  // ─── Session usage (Trust Surface — Phase 1) ───
  /** Cumulative token + cost for the current chat. Resets on chat switch. */
  sessionUsage: SessionUsage;

  // ─── Actions ───
  /** Immediately show loading state + optimistic user message before API returns. */
  beginSending: (text: string, attachments?: FileAttachment[]) => void;
  startGeneration: (streamId: string, sessionId: string) => void;
  startCompactionStream: (streamId: string, sessionId: string) => void;
  appendTextDelta: (text: string) => void;
  appendReasoningDelta: (text: string) => void;
  addToolStart: (tool: string, callId: string, args: Record<string, unknown>, title?: string | null) => void;
  setToolResult: (callId: string, output: string, title?: string | null, metadata?: Record<string, unknown> | null) => void;
  setToolError: (callId: string, output: string) => void;
  addStepStart: (step: number) => void;
  addStepFinish: (
    reason: string,
    tokens: Record<string, number>,
    cost: number,
    totalCost: number | null,
  ) => void;
  addCompaction: (auto: boolean) => void;
  startCompaction: (phases: string[]) => void;
  updateCompactionPhase: (phase: string, status: string) => void;
  updateCompactionProgress: (phase: string, chars: number) => void;
  addSubtask: (sessionId: string, title: string, description: string) => void;
  setPermissionRequest: (req: PermissionRequest) => void;
  clearPermissionRequest: () => void;
  setQuestion: (req: QuestionRequest) => void;
  clearQuestion: () => void;
  setPlanReview: (req: PlanReviewRequest) => void;
  clearPlanReview: () => void;
  setModelLoading: (loading: boolean) => void;
  setCompacting: (compacting: boolean) => void;
  clearStreamingContent: () => void;
  finishGeneration: () => void;
  reset: () => void;
}

/**
 * Flush accumulated text/reasoning deltas into parts.
 * Called before step boundaries and on finish.
 */
function flushBuffers(
  parts: PartData[],
  text: string,
  reasoning: string,
): { parts: PartData[]; text: string; reasoning: string } {
  const flushed = [...parts];
  if (reasoning) {
    flushed.push({ type: "reasoning", text: reasoning });
  }
  if (text) {
    flushed.push({ type: "text", text });
  }
  return { parts: flushed, text: "", reasoning: "" };
}

export const useChatStore = create<ChatStore>((set) => ({
  // State
  streamId: null,
  sessionId: null,
  isGenerating: false,
  isCompacting: false,
  pendingUserText: null,
  pendingAttachments: null,
  streamingParts: [],
  streamingText: "",
  streamingReasoning: "",
  isModelLoading: false,
  pendingPermission: null,
  pendingQuestion: null,
  pendingPlanReview: null,
  sessionUsage: EMPTY_SESSION_USAGE,

  // Actions
  beginSending: (text, attachments) =>
    set({
      isGenerating: true,
      isCompacting: false,
      isModelLoading: false,
      pendingUserText: text,
      pendingAttachments: attachments?.length ? attachments : null,
      streamingParts: [],
      streamingText: "",
      streamingReasoning: "",
      pendingPermission: null,
      pendingQuestion: null,
      pendingPlanReview: null,
    }),

  startGeneration: (streamId, sessionId) => {
    console.log("[chatStore] startGeneration called:", { streamId, sessionId });
    set({
      streamId,
      sessionId,
      isGenerating: true,
      isCompacting: false,
      // Keep pendingUserText visible during streaming — it will be cleared
      // in finishGeneration() when the DONE refetch brings the real DB message.
      streamingParts: [],
      streamingText: "",
      streamingReasoning: "",
      pendingPermission: null,
      pendingQuestion: null,
      pendingPlanReview: null,
    });
  },

  startCompactionStream: (streamId, sessionId) =>
    set((s) => {
      const { parts, text, reasoning } = flushBuffers(
        s.streamingParts,
        s.streamingText,
        s.streamingReasoning,
      );
      return {
        streamId,
        sessionId,
        isGenerating: false,
        isCompacting: true,
        isModelLoading: false,
        pendingUserText: null,
        pendingAttachments: null,
        streamingParts: parts,
        streamingText: text,
        streamingReasoning: reasoning,
        pendingPermission: null,
        pendingQuestion: null,
        pendingPlanReview: null,
      };
    }),

  appendTextDelta: (text) =>
    set((s) => ({ streamingText: s.streamingText + text })),

  appendReasoningDelta: (text) =>
    set((s) => ({ streamingReasoning: s.streamingReasoning + text })),

  addToolStart: (tool, callId, args, title) =>
    set((s) => {
      // Flush text buffers before tool
      const { parts, text, reasoning } = flushBuffers(
        s.streamingParts,
        s.streamingText,
        s.streamingReasoning,
      );
      const toolPart: ToolPart = {
        type: "tool",
        tool,
        call_id: callId,
        state: {
          status: "running",
          input: args,
          output: null,
          metadata: null,
          title: title ?? null,
          time_start: new Date().toISOString(),
          time_end: null,
          time_compacted: null,
        },
      };
      return {
        streamingParts: [...parts, toolPart],
        streamingText: text,
        streamingReasoning: reasoning,
      };
    }),

  setToolResult: (callId, output, title, metadata) =>
    set((s) => ({
      streamingParts: s.streamingParts.map((p) =>
        p.type === "tool" && p.call_id === callId
          ? {
              ...p,
              state: {
                ...p.state,
                status: "completed" as const,
                output,
                title: title ?? p.state.title,
                metadata: metadata ?? p.state.metadata,
                time_end: new Date().toISOString(),
              },
            }
          : p,
      ),
    })),

  setToolError: (callId, output) =>
    set((s) => ({
      streamingParts: s.streamingParts.map((p) =>
        p.type === "tool" && p.call_id === callId
          ? {
              ...p,
              state: {
                ...p.state,
                status: "error" as const,
                output,
                time_end: new Date().toISOString(),
              },
            }
          : p,
      ),
    })),

  addStepStart: (step) =>
    set((s) => {
      const { parts, text, reasoning } = flushBuffers(
        s.streamingParts,
        s.streamingText,
        s.streamingReasoning,
      );
      return {
        streamingParts: [
          ...parts,
          { type: "step-start", snapshot: { step } } as PartData,
        ],
        streamingText: text,
        streamingReasoning: reasoning,
      };
    }),

  addStepFinish: (reason, tokens, cost, totalCost) =>
    set((s) => {
      const { parts, text, reasoning } = flushBuffers(
        s.streamingParts,
        s.streamingText,
        s.streamingReasoning,
      );
      const prev = s.sessionUsage;
      const nextUsage: SessionUsage = {
        inputTokens: prev.inputTokens + (tokens?.input ?? 0),
        outputTokens: prev.outputTokens + (tokens?.output ?? 0),
        reasoningTokens: prev.reasoningTokens + (tokens?.reasoning ?? 0),
        cacheReadTokens: prev.cacheReadTokens + (tokens?.cache_read ?? 0),
        cacheWriteTokens: prev.cacheWriteTokens + (tokens?.cache_write ?? 0),
        // Backend total_cost is authoritative. Fall back to previous when omitted
        // (e.g., providers with no pricing — keeps prior value rather than zeroing).
        cost: totalCost ?? prev.cost,
      };
      return {
        streamingParts: [
          ...parts,
          {
            type: "step-finish",
            reason,
            tokens,
            cost,
          } as PartData,
        ],
        streamingText: text,
        streamingReasoning: reasoning,
        sessionUsage: nextUsage,
      };
    }),

  addCompaction: (auto) =>
    set((s) => {
      const parts = [...s.streamingParts];
      // Transition existing in-progress compaction part to completed
      let found = false;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (
          p.type === "compaction" &&
          (p as CompactionPart).compactionStatus === "in_progress"
        ) {
          parts[i] = { ...(p as CompactionPart), compactionStatus: "completed" };
          found = true;
          break;
        }
      }
      // Fallback: no in-progress part (e.g. SSE replay), push simple one
      if (!found) {
        parts.push({ type: "compaction", auto });
      }
      return { streamingParts: parts };
    }),

  startCompaction: (phases) =>
    set((s) => {
      // Guard: don't create duplicate if one is already in-progress
      const hasExisting = s.streamingParts.some(
        (p) => p.type === "compaction" && (p as CompactionPart).compactionStatus === "in_progress",
      );
      if (hasExisting) return s;

      const { parts, text, reasoning } = flushBuffers(
        s.streamingParts,
        s.streamingText,
        s.streamingReasoning,
      );
      const compactionPart: CompactionPart = {
        type: "compaction",
        auto: true,
        compactionStatus: "in_progress",
        phases: phases.map((p) => ({
          phase: p as CompactionPhase,
          status: "pending" as CompactionPhaseStatus,
        })),
      };
      return {
        isCompacting: true,
        streamingParts: [...parts, compactionPart],
        streamingText: text,
        streamingReasoning: reasoning,
      };
    }),

  updateCompactionPhase: (phase, status) =>
    set((s) => {
      const parts = [...s.streamingParts];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.type === "compaction" && (p as CompactionPart).phases) {
          const cp = { ...(p as CompactionPart) };
          cp.phases = cp.phases!.map((ph) =>
            ph.phase === phase ? { ...ph, status: status as CompactionPhaseStatus } : ph,
          );
          parts[i] = cp;
          break;
        }
      }
      return { streamingParts: parts };
    }),

  updateCompactionProgress: (phase, chars) =>
    set((s) => {
      const parts = [...s.streamingParts];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.type === "compaction" && (p as CompactionPart).phases) {
          const cp = { ...(p as CompactionPart) };
          cp.phases = cp.phases!.map((ph) =>
            ph.phase === phase ? { ...ph, chars } : ph,
          );
          parts[i] = cp;
          break;
        }
      }
      return { streamingParts: parts };
    }),

  addSubtask: (sessionId, title, description) =>
    set((s) => ({
      streamingParts: [
        ...s.streamingParts,
        { type: "subtask", session_id: sessionId, title, description },
      ],
    })),

  setPermissionRequest: (req) => set({ pendingPermission: req }),
  clearPermissionRequest: () => set({ pendingPermission: null }),

  setQuestion: (req) => set({ pendingQuestion: req }),
  clearQuestion: () => set({ pendingQuestion: null }),

  setPlanReview: (req) => set({ pendingPlanReview: req }),
  clearPlanReview: () => set({ pendingPlanReview: null }),

  setModelLoading: (loading) => set({ isModelLoading: loading }),

  setCompacting: (compacting) => set({ isCompacting: compacting }),

  clearStreamingContent: () =>
    set({
      streamingParts: [],
      streamingText: "",
      streamingReasoning: "",
    }),

  finishGeneration: () =>
    set((s) => {
      const { parts } = flushBuffers(
        s.streamingParts,
        s.streamingText,
        s.streamingReasoning,
      );
      return {
        streamId: null,
        isGenerating: false,
        isCompacting: false,
        isModelLoading: false,
        pendingUserText: null,
        pendingAttachments: null,
        pendingPermission: null,
        pendingQuestion: null,
        pendingPlanReview: null,
        streamingParts: parts,
        streamingText: "",
        streamingReasoning: "",
      };
    }),

  reset: () =>
    set({
      streamId: null,
      sessionId: null,
      isGenerating: false,
      isCompacting: false,
      isModelLoading: false,
      pendingUserText: null,
      pendingAttachments: null,
      streamingParts: [],
      streamingText: "",
      streamingReasoning: "",
      pendingPermission: null,
      pendingQuestion: null,
      pendingPlanReview: null,
      sessionUsage: EMPTY_SESSION_USAGE,
    }),
}));
