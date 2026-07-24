import type { AgentRunStatus } from "./message";

export type SubagentRunSource = "swarm" | "task";

/** One producer attribution retained when evidence is deduplicated. */
export interface EvidenceOrigin {
  sessionId: string;
  agentRunId?: string;
  agentTitle: string;
  agent: string;
  status: AgentRunStatus;
  tool: string | null;
  source: "parent" | SubagentRunSource;
}

/** Wire-format origin nested under a child output/source item. */
export interface SubagentEvidenceOrigin {
  session_id: string;
  agent_run_id: string;
  agent_title: string;
  status: AgentRunStatus;
  tool: string;
}

/** One child-produced file indexed into its parent's Workspace Summary. */
export interface SubagentOutput {
  name: string;
  path: string;
  type: string;
  tool?: string;
  origins?: SubagentEvidenceOrigin[];
}

/** One child-collected external source indexed into its parent's Workspace Summary. */
export interface SubagentSource {
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  favicon?: string;
  tool?: string;
  origins?: SubagentEvidenceOrigin[];
}

/** One persisted child-agent execution returned by GET /api/subagents. */
export interface SubagentRun {
  id: string;
  agent_run_id: string;
  agent: string;
  session_id: string;
  parent_session_id: string;
  parent_title: string | null;
  title: string;
  summary: string | null;
  status: AgentRunStatus;
  source: SubagentRunSource;
  swarm_id: string | null;
  ordinal: number | null;
  started_at: string | null;
  finished_at: string | null;
  last_message_at: string | null;
  time_updated: string;
  error: string | null;
  outputs: SubagentOutput[];
  sources: SubagentSource[];
}

export interface SubagentCounts {
  active: number;
  done: number;
  total: number;
}

export interface SubagentsResponse {
  active: SubagentRun[];
  done: SubagentRun[];
  counts: SubagentCounts;
}
