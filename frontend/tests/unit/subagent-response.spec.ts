import { expect, test } from "@playwright/test";
import { composeSubagentResponse } from "../../src/components/subagents/subagent-response";
import { useChatStore } from "../../src/stores/chat-store";

test.describe("Subagent final response composition", () => {
  test.afterEach(() => {
    useChatStore.getState().resetAll();
  });

  test("keeps text from every streamed step in order and appends the live tail", () => {
    expect(
      composeSubagentResponse({
        persistedText: "",
        streamingParts: [
          { type: "text", text: "Inspected the failing path." },
          {
            type: "tool",
            tool: "read",
            call_id: "read-1",
            state: {
              status: "completed",
              input: {},
              output: "ok",
              metadata: null,
              title: null,
              time_start: null,
              time_end: null,
              time_compacted: null,
            },
          },
          { type: "text", text: "Applied the targeted repair." },
        ],
        streamingText: "Verification is still running.",
      }),
    ).toBe(
      "Inspected the failing path.\n\nApplied the targeted repair.\n\nVerification is still running.",
    );
  });

  test("deduplicates replayed stream text while preserving its new suffix", () => {
    expect(
      composeSubagentResponse({
        persistedText: "Inspected the failing path.",
        streamingParts: [
          {
            type: "text",
            text: "Inspected the failing path.",
          },
        ],
        streamingText: "Applied the targeted repair.",
      }),
    ).toBe(
      "Inspected the failing path.\n\nApplied the targeted repair.",
    );
  });

  test("does not repeat step parts already contained in persisted history", () => {
    expect(
      composeSubagentResponse({
        persistedText:
          "Inspected the failing path.\n\nApplied the targeted repair.",
        streamingParts: [
          { type: "text", text: "Inspected the failing path." },
          { type: "text", text: "Applied the targeted repair." },
        ],
        streamingText: "Verification passed.",
      }),
    ).toBe(
      "Inspected the failing path.\n\nApplied the targeted repair.\n\nVerification passed.",
    );
  });

  test("merges a replay that starts at the last persisted step", () => {
    expect(
      composeSubagentResponse({
        persistedText:
          "Inspected the failing path.\n\nApplied the targeted repair.",
        streamingParts: [
          { type: "text", text: "Applied the targeted repair." },
        ],
        streamingText: "Verification passed.",
      }),
    ).toBe(
      "Inspected the failing path.\n\nApplied the targeted repair.\n\nVerification passed.",
    );
  });

  test("keeps the same partial response through a tool boundary and generation finish", () => {
    const sessionId = "child-live";
    const response = () => {
      const bucket = useChatStore.getState().sessions[sessionId];
      return composeSubagentResponse({
        persistedText: "",
        streamingParts: bucket?.streamingParts ?? [],
        streamingText: bucket?.streamingText ?? "",
      });
    };

    useChatStore.getState().startGeneration(sessionId, "stream-live");
    useChatStore
      .getState()
      .appendTextDelta(sessionId, "Inspected the failing path.");
    expect(response()).toBe("Inspected the failing path.");

    useChatStore
      .getState()
      .addToolStart(sessionId, "read", "read-1", {});
    expect(response()).toBe("Inspected the failing path.");

    useChatStore
      .getState()
      .appendTextDelta(sessionId, "Applied the targeted repair.");
    expect(response()).toBe(
      "Inspected the failing path.\n\nApplied the targeted repair.",
    );

    useChatStore.getState().finishGeneration(sessionId);
    expect(response()).toBe(
      "Inspected the failing path.\n\nApplied the targeted repair.",
    );
  });
});
