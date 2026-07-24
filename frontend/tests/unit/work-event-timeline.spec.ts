import { expect, test } from "@playwright/test";
import {
  buildWorkEventTimeline,
  formatWorkActivitySummary,
  summarizeWorkActivity,
} from "../../src/lib/work-event-timeline";
import type { PartData, ToolPart } from "../../src/types/message";

function completedTool(
  tool: string,
  callId: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> | null = null,
): ToolPart {
  return {
    type: "tool",
    tool,
    call_id: callId,
    state: {
      status: "completed",
      input,
      output: "",
      metadata,
      title: null,
      time_start: null,
      time_end: null,
      time_compacted: null,
    },
  };
}

test.describe("Work event timeline", () => {
  test("keeps content in part order and groups only adjacent activity parts", () => {
    const parts: PartData[] = [
      { type: "reasoning", text: "Inspecting the code" },
      completedTool("read", "read-1"),
      { type: "text", text: "I found the cause." },
      { type: "reasoning", text: "Applying the fix" },
      completedTool("edit", "edit-1"),
      completedTool("bash", "bash-1"),
      {
        type: "compaction",
        auto: true,
        compactionStatus: "completed",
      },
      { type: "text", text: "The fix is complete." },
    ];

    const events = buildWorkEventTimeline(parts);

    expect(
      events.map((event) =>
        event.type === "activity"
          ? {
              type: event.type,
              startIndex: event.startIndex,
              partTypes: event.parts.map((part) => part.type),
            }
          : {
              type: event.type,
              index: event.index,
              partType: event.part.type,
            },
      ),
    ).toEqual([
      {
        type: "activity",
        startIndex: 0,
        partTypes: ["reasoning", "tool"],
      },
      { type: "content", index: 2, partType: "text" },
      {
        type: "activity",
        startIndex: 3,
        partTypes: ["reasoning", "tool", "tool"],
      },
      { type: "content", index: 6, partType: "compaction" },
      { type: "content", index: 7, partType: "text" },
    ]);
  });

  test("uses step boundaries to keep separate action rows", () => {
    const parts: PartData[] = [
      { type: "step-start", snapshot: null },
      { type: "reasoning", text: "Inspecting" },
      completedTool("read", "read-1"),
      {
        type: "step-finish",
        reason: "tool_use",
        tokens: {},
        cost: 0,
      },
      { type: "step-start", snapshot: null },
      completedTool("edit", "edit-1"),
      {
        type: "step-finish",
        reason: "stop",
        tokens: {},
        cost: 0,
      },
      { type: "text", text: "Done." },
    ];

    const events = buildWorkEventTimeline(parts);

    expect(
      events.map((event) =>
        event.type === "activity"
          ? event.parts.map((part) => part.type)
          : event.part.type,
      ),
    ).toEqual([
      ["step-start", "reasoning", "tool", "step-finish"],
      ["step-start", "tool", "step-finish"],
      "text",
    ]);
  });

  test("deduplicates tools into canonical action categories in display order", () => {
    const summary = summarizeWorkActivity([
      completedTool("bash", "bash-1"),
      completedTool("edit", "edit-1"),
      completedTool("read", "read-1"),
      completedTool("grep", "grep-1"),
      completedTool("edit", "edit-2"),
      completedTool("glob", "glob-1"),
      completedTool("web_search", "web-1"),
      completedTool("tool_search", "tool-search-1"),
      completedTool("write", "write-1"),
      completedTool("write", "write-2"),
      completedTool("artifact", "artifact-1", { type: "mermaid" }),
      completedTool("task", "task-1"),
      completedTool("task", "task-2"),
      completedTool("bash", "bash-2"),
    ]);

    expect(summary).toEqual([
      { category: "editedFiles", count: 2 },
      { category: "readFiles", count: 1 },
      { category: "ranCommands", count: 2 },
      { category: "searchedFiles", count: 2 },
      { category: "usedBrowser", count: 1 },
      { category: "loadedTools", count: 1 },
      { category: "createdFiles", count: 2 },
      { category: "createdVisualizations", count: 1 },
      { category: "coordinatedAgents", count: 2 },
    ]);

    expect(formatWorkActivitySummary(summary, "en-US")).toBe(
      "Edited files, read a file, ran commands, searched files, used the browser, loaded a tool, created files, created a visualization, coordinated agents",
    );
    expect(formatWorkActivitySummary(summary, "zh-CN")).toBe(
      "编辑了 2 个文件、读取了 1 个文件、执行了 2 条命令、搜索了 2 个文件、使用了浏览器、加载了 1 个工具、创建了 2 个文件、创建了 1 个可视化、协调了 2 个 Agent",
    );
  });
});
