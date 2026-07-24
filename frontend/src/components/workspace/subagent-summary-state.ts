import type { AgentRunStatus, SwarmMemberPart } from "@/types/message";
import type { SubagentsResponse } from "@/types/subagent";

const ACTIVE_STATUSES = new Set<AgentRunStatus>([
  "pending",
  "running",
  "waiting_input",
]);

const DONE_STATUSES = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export interface SubagentSummaryState {
  counts: {
    active: number;
    done: number;
    total: number;
  };
  waitingCount: number;
  workingCount: number;
  usesLiveState: boolean;
}

/**
 * Merge persisted child runs with the current SSE swarm snapshot.
 *
 * While the parent is generating, the live snapshot is authoritative. After
 * generation ends, only terminal live states may advance an older API row;
 * stale active snapshots never regress a recovered terminal API result.
 */
export function deriveSubagentSummaryState(
  data: SubagentsResponse | undefined,
  liveMembers: SwarmMemberPart[],
  liveIsAuthoritative: boolean,
): SubagentSummaryState {
  const liveByRunId = new Map(
    liveMembers.map((member) => [member.agent_run_id, member]),
  );
  const liveBySessionId = new Map(
    liveMembers.map((member) => [member.session_id, member]),
  );
  const representedLiveRuns = new Set<string>();
  const statuses: AgentRunStatus[] = [];
  let usesLiveState = false;

  for (const run of [...(data?.active ?? []), ...(data?.done ?? [])]) {
    const live =
      liveByRunId.get(run.agent_run_id) ??
      liveBySessionId.get(run.session_id);
    if (!live) {
      statuses.push(run.status);
      continue;
    }

    representedLiveRuns.add(live.agent_run_id);
    const wouldRegressTerminalState =
      DONE_STATUSES.has(run.status) && ACTIVE_STATUSES.has(live.status);
    const canAdvanceTerminalState =
      DONE_STATUSES.has(live.status) && ACTIVE_STATUSES.has(run.status);
    if (
      !wouldRegressTerminalState &&
      (liveIsAuthoritative || canAdvanceTerminalState)
    ) {
      statuses.push(live.status);
      usesLiveState = true;
    } else {
      statuses.push(run.status);
    }
  }

  for (const member of liveMembers) {
    if (representedLiveRuns.has(member.agent_run_id)) continue;
    if (!liveIsAuthoritative && !DONE_STATUSES.has(member.status)) continue;
    representedLiveRuns.add(member.agent_run_id);
    statuses.push(member.status);
    usesLiveState = true;
  }

  if (!usesLiveState) {
    const counts = data?.counts ?? { active: 0, done: 0, total: 0 };
    const waitingCount =
      data?.active.filter((run) => run.status === "waiting_input").length ?? 0;
    const runningCount =
      data?.active.filter((run) => run.status === "running").length ?? 0;
    const pendingCount =
      data?.active.filter((run) => run.status === "pending").length ?? 0;
    return {
      counts,
      waitingCount,
      workingCount: runningCount > 0 ? runningCount : pendingCount,
      usesLiveState: false,
    };
  }

  const waitingCount = statuses.filter(
    (status) => status === "waiting_input",
  ).length;
  const runningCount = statuses.filter(
    (status) => status === "running",
  ).length;
  const pendingCount = statuses.filter(
    (status) => status === "pending",
  ).length;
  const doneCount = statuses.filter((status) =>
    DONE_STATUSES.has(status),
  ).length;

  return {
    counts: {
      active: waitingCount + runningCount + pendingCount,
      done: doneCount,
      total: statuses.length,
    },
    waitingCount,
    // A pending child is not yet working. If every active child is pending,
    // keep the existing concise "working" fallback instead of showing zero.
    workingCount: runningCount > 0 ? runningCount : pendingCount,
    usesLiveState: true,
  };
}
