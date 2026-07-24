/** Message & Part schemas — mirrors backend app/schemas/message.py */

// ─── Part types (discriminated union via 'type' field) ───

export interface TextPart {
  type: "text";
  text: string;
  synthetic?: boolean;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input: Record<string, unknown>;
  output: string | null;
  metadata: Record<string, unknown> | null;
  title: string | null;
  time_start: string | null;
  time_end: string | null;
  time_compacted: string | null;
}

export interface ToolPart {
  type: "tool";
  tool: string;
  call_id: string;
  state: ToolState;
}

export interface StepStartPart {
  type: "step-start";
  snapshot: Record<string, unknown> | null;
}

export interface StepFinishPart {
  type: "step-finish";
  reason: "stop" | "tool_use" | "length" | "error";
  tokens: Record<string, number>;
  cost: number;
}

export type CompactionPhase = "prune" | "summarize";
export type CompactionPhaseStatus = "pending" | "started" | "completed";

export interface CompactionPhaseState {
  phase: CompactionPhase;
  status: CompactionPhaseStatus;
  /** Character count of summary (only for "summarize" phase). */
  chars?: number;
}

export interface CompactionPart {
  type: "compaction";
  auto: boolean;
  /** Present during live streaming; absent for completed (DB-loaded) parts. */
  phases?: CompactionPhaseState[];
  /** Overall compaction status. */
  compactionStatus?: "in_progress" | "completed";
}

export interface SubtaskPart {
  type: "subtask";
  session_id: string;
  title: string;
  description: string;
  task_id?: string | null;
  parent_id?: string | null;
  agent?: string | null;
  status?: AgentRunStatus | null;
  depth?: number | null;
  revision?: number | null;
  resumed?: boolean;
  error?: string | null;
  cost?: number;
  tokens?: Record<string, number>;
  started_at?: string | null;
  finished_at?: string | null;
}

export type AgentRunStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface SwarmMemberPart {
  agent_run_id: string;
  session_id: string;
  ordinal: number;
  title: string;
  agent: string;
  provider_id?: string | null;
  model_id?: string | null;
  depth: number;
  status: AgentRunStatus;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  cost: number;
  tokens: Record<string, number>;
}

export interface SwarmPart {
  type: "swarm";
  schema_version: 1;
  swarm_id: string;
  parent_session_id: string;
  revision: number;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  strategy: "parallel";
  failure_policy: "continue";
  started_at: string;
  finished_at?: string | null;
  members: SwarmMemberPart[];
}

export interface FilePart {
  type: "file";
  file_id: string;
  name: string;
  path: string;
  size: number;
  mime_type: string;
  source?: "referenced" | "uploaded";
  content_hash?: string;
}

export type PartData =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | CompactionPart
  | SubtaskPart
  | SwarmPart
  | FilePart;

// ─── Message info types ───

export interface ModelRef {
  provider_id: string;
  model_id: string;
}

export interface TokenUsage {
  /** Prompt tokens excluding cache hits. */
  input: number;
  /** Non-reasoning completion tokens. */
  output: number;
  /** Completion tokens spent on reasoning/thinking traces. */
  reasoning: number;
  /** Prompt tokens read from cache (cache hits). */
  cache_read: number;
  /** Prompt tokens written into cache. */
  cache_write: number;
}

export interface UserMessageInfo {
  role: "user";
  model?: ModelRef | null;
  agent?: string;
  system?: string | null;
  variant?: string | null;
  tools?: string[] | null;
}

export interface AssistantMessageInfo {
  role: "assistant";
  parent_id?: string | null;
  agent?: string;
  model_id?: string | null;
  provider_id?: string | null;
  cost?: number;
  tokens?: TokenUsage;
  error?: string | null;
  finish?: "stop" | "tool_use" | "length" | "error" | null;
  summary?: boolean;
  mode?: string | null;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

// ─── API response schemas ───

export interface PartResponse {
  id: string;
  message_id: string;
  session_id: string;
  time_created: string;
  data: PartData;
}

export interface MessageResponse {
  id: string;
  session_id: string;
  time_created: string;
  data: MessageInfo;
  /** Set when context collapse dropped this message from the prompt. The
   * message remains part of the transcript and must still be rendered. */
  collapsed_at?: string | null;
  parts: PartResponse[];
}

export interface PaginatedMessages {
  total: number;
  offset: number;
  messages: MessageResponse[];
}
