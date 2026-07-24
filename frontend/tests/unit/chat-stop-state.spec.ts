import { expect, test } from "@playwright/test";
import { useChatStore } from "../../src/stores/chat-store";
import type { SubtaskPart, SwarmPart } from "../../src/types/message";

test.describe("Chat stop state", () => {
  test.afterEach(() => {
    useChatStore.getState().resetAll();
  });

  test("turns a live swarm into the user-stopped terminal state", () => {
    const sessionId = "session-swarm-stop";
    const swarm: SwarmPart = {
      type: "swarm",
      schema_version: 1,
      swarm_id: "swarm-stop",
      parent_session_id: sessionId,
      revision: 1,
      status: "running",
      strategy: "parallel",
      failure_policy: "continue",
      started_at: "2026-07-23T12:00:00.000Z",
      members: [
        {
          agent_run_id: "run-active",
          session_id: "child-active",
          ordinal: 0,
          title: "Active worker",
          agent: "build",
          depth: 1,
          status: "running",
          cost: 0,
          tokens: {},
        },
        {
          agent_run_id: "run-done",
          session_id: "child-done",
          ordinal: 1,
          title: "Completed worker",
          agent: "build",
          depth: 1,
          status: "completed",
          cost: 0,
          tokens: {},
        },
      ],
    };

    const chat = useChatStore.getState();
    chat.startGeneration(sessionId, "stream-swarm-stop");
    chat.upsertSwarmState(sessionId, swarm);
    chat.stopGeneration(sessionId);

    const stopped = useChatStore
      .getState()
      .sessions[sessionId]
      .streamingParts.find((part) => part.type === "swarm");

    expect(stopped).toMatchObject({
      type: "swarm",
      status: "cancelled",
      members: [
        { status: "cancelled" },
        { status: "completed" },
      ],
    });
    expect(stopped?.type === "swarm" && stopped.finished_at).toBeTruthy();
  });

  test("turns a live ordinary subtask into the user-stopped terminal state", () => {
    const sessionId = "session-subtask-stop";
    const subtask: SubtaskPart = {
      type: "subtask",
      task_id: "child-task",
      session_id: "child-session",
      parent_id: sessionId,
      title: "Active delegated task",
      description: "build Agent",
      agent: "build",
      status: "waiting_input",
      depth: 1,
      revision: 2,
      resumed: false,
      error: null,
      cost: 0,
      tokens: {},
      started_at: "2026-07-23T12:00:00.000Z",
      finished_at: null,
    };

    const chat = useChatStore.getState();
    chat.startGeneration(sessionId, "stream-subtask-stop");
    chat.upsertSubtaskState(sessionId, subtask);
    chat.stopGeneration(sessionId);

    const stopped = useChatStore
      .getState()
      .sessions[sessionId]
      .streamingParts.find((part) => part.type === "subtask");

    expect(stopped).toMatchObject({
      type: "subtask",
      status: "cancelled",
      revision: 3,
    });
    expect(stopped?.type === "subtask" && stopped.finished_at).toBeTruthy();
  });
});
