"use client";

import { create } from "zustand";
import type { CompactionPart, CompactionPhase, CompactionPhaseStatus, PartData, ToolPart } from "@/types/message";
import type { PermissionRequest, QuestionRequest, PlanReviewRequest } from "@/types/streaming";
import type { FileAttachment } from "@/types/chat";

/**
 * Cumulative usage for the current chat session (across multiple generations).
 * Reset only on `reset()` (e.g., switching chats); preserved across `finishGeneration`.
 *
 * Named `LiveSessionUsage` to disambiguate from the persisted `SessionUsage`
 * row in `@/types/usage` (which models stored stats with `total_cost`,
 * `total_tokens`, `message_count`).
 *
 * - `cost` mirrors the backend-authoritative `total_cost` from the latest
 *   step_finish. `null` when no provider has reported pricing yet.
 * - Token fields are accumulated frontend-side from `step_finish.tokens`.
 *   Will reset on page refresh until Phase 2 wires backend persistence.
 */
export interface LiveSessionUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
}

const EMPTY_SESSION_USAGE: LiveSessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: null,
};

/**
 * Bounded LRU-ish set of step_finish event ids already applied to
 * sessionUsage, used to drop SSE replays after Last-Event-ID resume.
 * Lives outside the store so it does not trigger re-renders.
 *
 * SSE event ids in this codebase are numbers (auto-increment per stream),
 * not strings; callers pass them through unchanged.
 */
const SEEN_STEP_FINISH_IDS = new Set<number>();
const SEEN_STEP_FINISH_LIMIT = 256;
function rememberStepFinishId(id: number | null | undefined): boolean {
  if (id === null || id === undefined) return false; // unknown id — skip dedup
  if (SEEN_STEP_FINISH_IDS.has(id)) return true; // already seen
  SEEN_STEP_FINISH_IDS.add(id);
  if (SEEN_STEP_FINISH_IDS.size > SEEN_STEP_FINISH_LIMIT) {
    // Drop the oldest entry — Set preserves insertion order.
    const oldest = SEEN_STEP_FINISH_IDS.values().next().value;
    if (oldest !== undefined) SEEN_STEP_FINISH_IDS.delete(oldest);
  }
  return false;
}
function clearSeenStepFinishIds(): void {
  SEEN_STEP_FINISH_IDS.clear();
}

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

  // ─── Model loading (local-runtime cold start) ───
  isModelLoading: boolean;

  // ─── Interactive prompts ───
  pendingPermission: PermissionRequest | null;
  pendingQuestion: QuestionRequest | null;
  pendingPlanReview: PlanReviewRequest | null;

  // ─── Session usage (Trust Surface — Phase 1) ───
  /** Cumulative token + cost for the current chat. Resets on chat switch. */
  sessionUsage: LiveSessionUsage;

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
    /** SSE event id; used to drop replays after Last-Event-ID resume. */
    eventId?: number | null,
    /** Session id from the SSE event payload; used to drop late events
     *  arriving after the user switched chats. */
    eventSessionId?: string | null,
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
  /**
   * Mark a chat as the active one. Resets per-chat session usage and the
   * step_finish dedup set; intended to be called from the sessionId-keyed
   * effect in chat-view.tsx so direct route navigation (/c/A → /c/B) does
   * not leak A's running totals onto B.
   */
  enterChat: (sessionId: string | null) => void;
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

  addStepFinish: (reason, tokens, cost, totalCost, eventId, eventSessionId) =>
    set((s) => {
      const { parts, text, reasoning } = flushBuffers(
        s.streamingParts,
        s.streamingText,
        s.streamingReasoning,
      );
      // The streaming part is always appended (it drives the UI step tracker
      // regardless of whether the event is for this chat); the *usage*
      // accumulator is what we guard.
      const baseReturn = {
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
      };

      // Guard 1 — drop late SSE events arriving after a chat switch.
      // If the event carries a session_id and we know our active session,
      // both must match before we touch the usage counter.
      if (eventSessionId && s.sessionId && eventSessionId !== s.sessionId) {
        return baseReturn;
      }

      // Guard 2 — drop SSE replays from Last-Event-ID resume.
      // Token accumulation is not idempotent; cost is mirrored from
      // backend.total_cost so it would be safe even on a replay, but token
      // counts would double. Only dedup when an id is provided.
      if (eventId && rememberStepFinishId(eventId)) {
        return baseReturn;
      }

      const prev = s.sessionUsage;
      const inputDelta = tokens?.input ?? 0;
      const outputDelta = tokens?.output ?? 0;
      const reasoningDelta = tokens?.reasoning ?? 0;
      const cacheReadDelta = tokens?.cache_read ?? 0;
      const cacheWriteDelta = tokens?.cache_write ?? 0;
      const tokenDelta =
        inputDelta + outputDelta + reasoningDelta + cacheReadDelta + cacheWriteDelta;

      // Cost reconciliation:
      //   1. Backend `total_cost` is the authoritative running total.
      //   2. Treat 0 as "not yet priced" so unpriced providers (local
      //      runtime, custom endpoints) don't show a misleading "≈$0.0000".
      //   3. Fallback to previous-cost + per-step cost when backend doesn't
      //      report total_cost yet (older backend / per-step-only emitter).
      let nextCost: number | null;
      if (totalCost !== null && totalCost > 0) {
        nextCost = totalCost;
      } else if (cost > 0) {
        nextCost = (prev.cost ?? 0) + cost;
      } else {
        nextCost = prev.cost; // unchanged — preserves earlier known value if any
      }

      // Skip allocating a new sessionUsage object when nothing changed
      // (e.g., non-terminal step_finish for tool_use carries tokens=null).
      // Saves a re-render pulse for SessionStats during streaming.
      if (tokenDelta === 0 && nextCost === prev.cost) {
        return baseReturn;
      }

      const nextUsage: LiveSessionUsage = {
        inputTokens: prev.inputTokens + inputDelta,
        outputTokens: prev.outputTokens + outputDelta,
        reasoningTokens: prev.reasoningTokens + reasoningDelta,
        cacheReadTokens: prev.cacheReadTokens + cacheReadDelta,
        cacheWriteTokens: prev.cacheWriteTokens + cacheWriteDelta,
        cost: nextCost,
      };
      return { ...baseReturn, sessionUsage: nextUsage };
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

  enterChat: (sessionId) => {
    clearSeenStepFinishIds();
    set({ sessionId, sessionUsage: EMPTY_SESSION_USAGE });
  },

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

  reset: () => {
    clearSeenStepFinishIds();
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
    });
  },
}));
