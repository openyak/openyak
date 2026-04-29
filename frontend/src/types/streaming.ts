/** SSE event types — mirrors backend app/streaming/events.py */

export const SSE_EVENTS = {
  TEXT_DELTA: "text-delta",
  REASONING_DELTA: "reasoning-delta",
  TOOL_START: "tool-call",
  TOOL_RESULT: "tool-result",
  TOOL_ERROR: "tool-error",
  STEP_START: "step-start",
  STEP_FINISH: "step-finish",
  COMPACTED: "compacted",
  COMPACTION_START: "compaction-start",
  COMPACTION_PHASE: "compaction-phase",
  COMPACTION_PROGRESS: "compaction-progress",
  PERMISSION_REQUEST: "permission-request",
  QUESTION: "question",
  TITLE_UPDATE: "title-update",
  RETRY: "retry",
  DESYNC: "desync",
  DONE: "done",
  AGENT_ERROR: "agent-error",
  ERROR: "error",
  COMPACTION_ERROR: "compaction-error",
  PLAN_REVIEW: "plan-review",
  MODEL_LOADING: "model-loading",
  PERMISSION_RESOLVED: "permission-resolved",
  QUESTION_RESOLVED: "question-resolved",
} as const;

/** SSE event payload — mirrors backend app/schemas/streaming.py SSEEventData */
export interface SSEEventData {
  // Common
  session_id?: string | null;
  message_id?: string | null;

  // text_delta / reasoning_delta
  text?: string | null;

  // tool_start / tool_result / tool_error
  tool?: string | null;
  call_id?: string | null;
  arguments?: Record<string, unknown> | null;
  output?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;

  // step_finish
  tokens?: Record<string, number> | null;
  cost?: number | null;
  total_cost?: number | null;
  reason?: string | null;

  // permission_request
  permission?: string | null;
  patterns?: string[] | null;
  tool_call_id?: string | null;
  message?: string | null;
  arguments_truncated?: boolean | null;

  // question (legacy single-question mode)
  question?: string | null;
  options?: unknown[] | null;

  // question (multi-question mode)
  questions?: QuestionItem[] | null;

  // error
  error_type?: string | null;
  error_message?: string | null;

  // done
  finish_reason?: string | null;

  // compaction_start / compaction_phase / compaction_progress / compacted
  phases?: string[] | null;
  phase?: string | null;
  status?: string | null;
  chars?: number | null;
  summary_created?: boolean | null;

  // step_start
  step?: number | null;

  // plan-review
  plan?: string | null;
  files_to_modify?: string[] | null;
}

/** Parsed SSE event with type and data. */
export interface ParsedSSEEvent {
  id: number;
  event: string;
  data: SSEEventData;
}

/** Permission request from SSE stream. */
export interface PermissionRequest {
  callId: string;
  toolCallId?: string | null;
  tool: string;
  permission: string;
  patterns: string[];
  arguments: Record<string, unknown>;
  message?: string | null;
  argumentsTruncated?: boolean;
}

/** Single option within a multi-question item. */
export interface QuestionOptionItem {
  label: string;
  description?: string;
  preview?: string;
}

/** Single question in multi-question mode. */
export interface QuestionItem {
  question: string;
  header: string;
  options?: QuestionOptionItem[];
  multiSelect?: boolean;
}

/** Question prompt from SSE stream. */
export interface QuestionRequest {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** Plan review request from SSE stream. */
export interface PlanReviewRequest {
  callId: string;
  title: string;
  plan: string;
  filesToModify: string[];
}
