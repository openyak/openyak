import { expect, test } from "@playwright/test";
import {
  collectTaskSummaryEvidence,
  collectTaskSummaryOutputs,
  type ParentEvidenceContext,
} from "../../src/components/workspace/workspace-summary-data";
import { isSafeExternalSourceUrl } from "../../src/lib/sources";
import type { WorkspaceFile } from "../../src/stores/workspace-store";
import type { MessageResponse } from "../../src/types/message";
import type {
  SubagentRun,
  SubagentsResponse,
} from "../../src/types/subagent";

function run(
  id: string,
  overrides: Partial<SubagentRun> = {},
): SubagentRun {
  return {
    id,
    agent_run_id: id,
    agent: "research",
    session_id: `child-${id}`,
    parent_session_id: "session-parent",
    parent_title: "Parent task",
    title: `Agent ${id}`,
    summary: null,
    status: "completed",
    source: "swarm",
    swarm_id: "swarm-1",
    ordinal: 0,
    started_at: "2026-07-23T10:00:00.000Z",
    finished_at: "2026-07-23T10:01:00.000Z",
    last_message_at: "2026-07-23T10:01:00.000Z",
    time_updated: "2026-07-23T10:01:00.000Z",
    error: null,
    outputs: [],
    sources: [],
    ...overrides,
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

const parent: ParentEvidenceContext = {
  sessionId: "session-parent",
  agentTitle: "Parent task",
  agent: "build",
  status: "completed",
};

test.describe("Workspace Summary child evidence lineage", () => {
  test("merges parent and child outputs by path while retaining child provenance", () => {
    const parentFiles: WorkspaceFile[] = [
      {
        name: "shared.md",
        path: "/workspace/shared.md",
        type: "generated",
      },
    ];
    const child = run("review", {
      title: "Release review",
      agent: "build",
      outputs: [
        {
          name: "shared.md",
          path: "/workspace/shared.md",
          type: "generated",
          tool: "write",
        },
        {
          name: "findings.md",
          path: "/workspace/findings.md",
          type: "generated",
          tool: "artifact",
          origins: [
            {
              session_id: "child-review",
              agent_run_id: "review",
              agent_title: "Release review",
              status: "completed",
              tool: "artifact",
            },
            {
              session_id: "child-review",
              agent_run_id: "review",
              agent_title: "Release review",
              status: "completed",
              tool: "write",
            },
          ],
        },
      ],
    });

    expect(
      collectTaskSummaryOutputs(parentFiles, response([], [child]), parent),
    ).toEqual([
      {
        name: "shared.md",
        path: "/workspace/shared.md",
        type: "generated",
        origins: [
          {
            sessionId: "session-parent",
            agentTitle: "Parent task",
            agent: "build",
            status: "completed",
            tool: null,
            source: "parent",
          },
          {
            sessionId: "child-review",
            agentRunId: "review",
            agentTitle: "Release review",
            agent: "build",
            status: "completed",
            tool: "write",
            source: "swarm",
          },
        ],
      },
      {
        name: "findings.md",
        path: "/workspace/findings.md",
        type: "generated",
        tool: "artifact",
        origins: [
          {
            sessionId: "child-review",
            agentRunId: "review",
            agentTitle: "Release review",
            agent: "build",
            status: "completed",
            tool: "artifact",
            source: "swarm",
          },
          {
            sessionId: "child-review",
            agentRunId: "review",
            agentTitle: "Release review",
            agent: "build",
            status: "completed",
            tool: "write",
            source: "swarm",
          },
        ],
      },
    ]);
  });

  test("deduplicates parent/child source URLs without losing terminal origins", () => {
    const parentMessage = {
      id: "message-parent",
      session_id: "session-parent",
      time_created: "2026-07-23T09:59:00.000Z",
      data: { role: "assistant", agent: "build", finish: "stop" },
      parts: [
        {
          id: "part-source",
          message_id: "message-parent",
          session_id: "session-parent",
          time_created: "2026-07-23T09:59:00.000Z",
          data: {
            type: "tool",
            tool: "web_search",
            call_id: "search-parent",
            state: {
              status: "completed",
              input: {},
              output: "",
              metadata: {
                results: [
                  {
                    url: "https://example.com/guide/#checks",
                    title: "Parent guide",
                  },
                ],
              },
              title: "Search",
              time_start: null,
              time_end: null,
              time_compacted: null,
            },
          },
        },
      ],
    } as MessageResponse;
    const active = run("audit", {
      status: "running",
      sources: [
        {
          url: "https://example.com/guide/#checks",
          title: "Guide",
          domain: "example.com",
          tool: "web_fetch",
        },
      ],
    });
    const settled = run("audit", {
      status: "failed",
      sources: [
        {
          url: "https://example.com/guide/",
          title: "Release guide",
          domain: "example.com",
          snippet: "Authoritative release checks.",
          tool: "web_fetch",
        },
      ],
    });
    const cancelled = run("cancelled", {
      status: "cancelled",
      sources: [
        {
          url: "https://example.com/guide",
          title: "Cancelled review guide",
          domain: "example.com",
          tool: "web_fetch",
        },
      ],
    });

    const evidence = collectTaskSummaryEvidence(
      [parentMessage],
      [],
      [],
      response([active], [settled, cancelled]),
      parent,
    );

    expect(evidence.sources).toHaveLength(1);
    expect(evidence.sources[0]).toMatchObject({
      url: "https://example.com/guide/",
      title: "Parent guide",
      domain: "example.com",
      snippet: "Authoritative release checks.",
      tool: "web_search",
      origins: [
        {
          sessionId: "session-parent",
          agentTitle: "Parent task",
          agent: "build",
          status: "completed",
          tool: "web_search",
          source: "parent",
        },
        {
          sessionId: "child-audit",
          agentRunId: "audit",
          agentTitle: "Agent audit",
          agent: "research",
          status: "failed",
          tool: "web_fetch",
          source: "swarm",
        },
        {
          sessionId: "child-cancelled",
          agentRunId: "cancelled",
          agentTitle: "Agent cancelled",
          agent: "research",
          status: "cancelled",
          tool: "web_fetch",
          source: "swarm",
        },
      ],
    });
  });

  test("only normal web source URLs are interactive", () => {
    expect(isSafeExternalSourceUrl("https://example.com/evidence")).toBe(true);
    expect(isSafeExternalSourceUrl("http://localhost:3317/evidence")).toBe(true);
    for (const unsafeUrl of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///tmp/evidence",
      "blob:https://example.com/id",
      "https://user:secret@example.com/evidence",
      "https://example.com/evidence\nspoof",
      "https://",
    ]) {
      expect(isSafeExternalSourceUrl(unsafeUrl)).toBe(false);
    }
  });
});
