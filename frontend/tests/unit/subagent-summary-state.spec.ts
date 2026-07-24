import { expect, test } from "@playwright/test";
import { deriveSubagentSummaryState } from "../../src/components/workspace/subagent-summary-state";
import type { AgentRunStatus, SwarmMemberPart } from "../../src/types/message";
import type { SubagentRun, SubagentsResponse } from "../../src/types/subagent";

const now = "2026-07-24T16:00:00.000Z";

function run(id: string, status: AgentRunStatus): SubagentRun {
  return {
    id,
    agent_run_id: `run-${id}`,
    agent: "research",
    session_id: `child-${id}`,
    parent_session_id: "parent",
    parent_title: "Parent task",
    title: id,
    summary: null,
    status,
    source: "swarm",
    swarm_id: "swarm-release",
    ordinal: 0,
    started_at: now,
    finished_at:
      status === "completed" || status === "failed" || status === "cancelled"
        ? now
        : null,
    last_message_at: now,
    time_updated: now,
    error: null,
    outputs: [],
    sources: [],
  };
}

function member(id: string, status: AgentRunStatus): SwarmMemberPart {
  return {
    agent_run_id: `run-${id}`,
    session_id: `child-${id}`,
    ordinal: 0,
    title: id,
    agent: "research",
    depth: 1,
    status,
    started_at: now,
    finished_at:
      status === "completed" || status === "failed" || status === "cancelled"
        ? now
        : null,
    error: null,
    cost: 0,
    tokens: {},
  };
}

function response(
  active: SubagentRun[],
  done: SubagentRun[],
): SubagentsResponse {
  return {
    active,
    done,
    counts: {
      active: active.length,
      done: done.length,
      total: active.length + done.length,
    },
  };
}

test("live swarm counts running children without calling pending work active", () => {
  const data = response(
    [run("streaming", "running"), run("accessibility", "running")],
    [],
  );

  const summary = deriveSubagentSummaryState(
    data,
    [
      member("streaming", "running"),
      member("accessibility", "running"),
      member("release", "pending"),
    ],
    true,
  );

  expect(summary).toMatchObject({
    counts: { active: 3, done: 0, total: 3 },
    waitingCount: 0,
    workingCount: 2,
    usesLiveState: true,
  });
});

test("live swarm advances the summary through partial completion", () => {
  const data = response(
    [run("streaming", "running"), run("accessibility", "running")],
    [],
  );

  const summary = deriveSubagentSummaryState(
    data,
    [
      member("streaming", "completed"),
      member("accessibility", "running"),
      member("release", "running"),
    ],
    true,
  );

  expect(summary).toMatchObject({
    counts: { active: 2, done: 1, total: 3 },
    waitingCount: 0,
    workingCount: 2,
  });
});

test("a stale active snapshot cannot regress a recovered terminal API row", () => {
  const data = response([], [run("streaming", "completed")]);

  const summary = deriveSubagentSummaryState(
    data,
    [member("streaming", "running")],
    false,
  );

  expect(summary).toMatchObject({
    counts: { active: 0, done: 1, total: 1 },
    workingCount: 0,
    usesLiveState: false,
  });
});

test("authoritative live state still cannot regress a terminal API row", () => {
  const data = response([], [run("streaming", "completed")]);

  const summary = deriveSubagentSummaryState(
    data,
    [member("streaming", "running")],
    true,
  );

  expect(summary).toMatchObject({
    counts: { active: 0, done: 1, total: 1 },
    workingCount: 0,
    usesLiveState: false,
  });
});

test("a terminal live snapshot can advance an older active API row", () => {
  const data = response([run("streaming", "running")], []);

  const summary = deriveSubagentSummaryState(
    data,
    [member("streaming", "completed")],
    false,
  );

  expect(summary).toMatchObject({
    counts: { active: 0, done: 1, total: 1 },
    workingCount: 0,
    usesLiveState: true,
  });
});

test("API-only summary does not count pending children as working", () => {
  const data = response(
    [
      run("streaming", "running"),
      run("release", "pending"),
      run("accessibility", "pending"),
    ],
    [],
  );

  const summary = deriveSubagentSummaryState(data, [], false);

  expect(summary).toMatchObject({
    counts: { active: 3, done: 0, total: 3 },
    waitingCount: 0,
    workingCount: 1,
    usesLiveState: false,
  });
});
