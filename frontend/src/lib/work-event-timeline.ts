import type {
  PartData,
  ReasoningPart,
  StepFinishPart,
  StepStartPart,
  ToolPart,
} from "@/types/message";

export type WorkActivityPart =
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart;

export interface WorkActivityEvent {
  type: "activity";
  startIndex: number;
  endIndex: number;
  parts: WorkActivityPart[];
}

export interface WorkContentEvent {
  type: "content";
  index: number;
  part: Exclude<
    PartData,
    ReasoningPart | ToolPart | StepStartPart | StepFinishPart
  >;
}

export type WorkTimelineEvent = WorkActivityEvent | WorkContentEvent;

export const WORK_ACTIVITY_CATEGORY_ORDER = [
  "editedFiles",
  "readFiles",
  "ranCommands",
  "searchedFiles",
  "usedBrowser",
  "loadedTools",
  "createdFiles",
  "createdVisualizations",
  "coordinatedAgents",
] as const;

export type WorkActivityCategory =
  (typeof WORK_ACTIVITY_CATEGORY_ORDER)[number];

export interface WorkActivitySummaryItem {
  category: WorkActivityCategory;
  count: number;
}

export function isWorkActivityPart(part: PartData): part is WorkActivityPart {
  return (
    part.type === "reasoning" ||
    part.type === "tool" ||
    part.type === "step-start" ||
    part.type === "step-finish"
  );
}

/**
 * Preserve the server part sequence while collapsing only adjacent execution
 * details into one readable work event.
 */
export function buildWorkEventTimeline(parts: PartData[]): WorkTimelineEvent[] {
  const events: WorkTimelineEvent[] = [];
  let activity: WorkActivityEvent | null = null;

  const flushActivity = () => {
    if (!activity) return;
    events.push(activity);
    activity = null;
  };

  const appendActivityPart = (part: WorkActivityPart, index: number) => {
    if (!activity) {
      activity = {
        type: "activity",
        startIndex: index,
        endIndex: index,
        parts: [],
      };
    }
    activity.parts.push(part);
    activity.endIndex = index;
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part.type === "step-start") {
      flushActivity();
      appendActivityPart(part, index);
      continue;
    }

    if (part.type === "step-finish") {
      appendActivityPart(part, index);
      flushActivity();
      continue;
    }

    if (isWorkActivityPart(part)) {
      appendActivityPart(part, index);
      continue;
    }

    flushActivity();
    events.push({ type: "content", index, part });
  }

  flushActivity();
  return events;
}

const VISUAL_ARTIFACT_TYPES = new Set([
  "html",
  "image",
  "mermaid",
  "react",
  "svg",
  "visualization",
]);

function recordValue(
  record: Record<string, unknown> | null | undefined,
  key: string,
): unknown {
  return record?.[key];
}

function isBrowserTool(tool: string): boolean {
  if (tool === "web_search" || tool === "web_fetch") return true;
  const normalized = tool.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return /(^|_)(browser|chrome|playwright)(_|$)/.test(normalized);
}

/**
 * Convert implementation-level tool calls into the stable, user-facing action
 * vocabulary used by the conversation journal.
 */
export function summarizeWorkActivity(
  toolParts: readonly ToolPart[],
): WorkActivitySummaryItem[] {
  const counts = new Map<WorkActivityCategory, number>();
  const add = (category: WorkActivityCategory, count = 1) => {
    if (count <= 0) return;
    counts.set(category, (counts.get(category) ?? 0) + count);
  };

  for (const part of toolParts) {
    const tool = part.tool.toLowerCase();
    const input = part.state.input;
    const metadata = part.state.metadata;

    if (tool === "edit" || tool === "multi_edit") {
      add("editedFiles");
      continue;
    }

    if (tool === "apply_patch") {
      const patchText = recordValue(input, "patch_text");
      if (typeof patchText !== "string") {
        add("editedFiles");
        continue;
      }
      const editedCount =
        patchText.match(/^\*\*\* (?:Update|Delete) File:/gm)?.length ?? 0;
      const createdCount =
        patchText.match(/^\*\*\* Add File:/gm)?.length ?? 0;
      add("editedFiles", editedCount);
      add("createdFiles", createdCount);
      if (editedCount === 0 && createdCount === 0) add("editedFiles");
      continue;
    }

    if (tool === "read") {
      add("readFiles");
      continue;
    }

    if (tool === "bash") {
      add("ranCommands");
      continue;
    }

    if (tool === "code_execute") {
      add("ranCommands");
      const writtenFiles = recordValue(metadata, "written_files");
      if (Array.isArray(writtenFiles)) add("createdFiles", writtenFiles.length);
      continue;
    }

    if (tool === "glob" || tool === "grep" || tool === "search") {
      add("searchedFiles");
      continue;
    }

    if (isBrowserTool(tool)) {
      add("usedBrowser");
      continue;
    }

    if (tool === "tool_search" || tool === "skill") {
      add("loadedTools");
      continue;
    }

    if (tool === "write" || tool === "submit_plan") {
      add("createdFiles");
      continue;
    }

    if (tool === "artifact") {
      const artifactType = String(
        recordValue(input, "type") ?? recordValue(metadata, "type") ?? "",
      ).toLowerCase();
      add(
        VISUAL_ARTIFACT_TYPES.has(artifactType)
          ? "createdVisualizations"
          : "createdFiles",
      );
      continue;
    }

    if (tool === "task") {
      add("coordinatedAgents");
      continue;
    }

    if (tool === "swarm") {
      const tasks = recordValue(input, "tasks");
      add("coordinatedAgents", Array.isArray(tasks) ? Math.max(tasks.length, 1) : 1);
    }
  }

  return WORK_ACTIVITY_CATEGORY_ORDER.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0 ? [{ category, count }] : [];
  });
}

const ENGLISH_ACTIVITY_PHRASES: Record<
  WorkActivityCategory,
  (count: number) => string
> = {
  editedFiles: (count) => (count === 1 ? "edited a file" : "edited files"),
  readFiles: (count) => (count === 1 ? "read a file" : "read files"),
  ranCommands: (count) => (count === 1 ? "ran a command" : "ran commands"),
  searchedFiles: (count) =>
    count === 1 ? "searched a file" : "searched files",
  usedBrowser: () => "used the browser",
  loadedTools: (count) => (count === 1 ? "loaded a tool" : "loaded tools"),
  createdFiles: (count) => (count === 1 ? "created a file" : "created files"),
  createdVisualizations: (count) =>
    count === 1 ? "created a visualization" : "created visualizations",
  coordinatedAgents: (count) =>
    count === 1 ? "coordinated an agent" : "coordinated agents",
};

const CHINESE_ACTIVITY_PHRASES: Record<
  WorkActivityCategory,
  (count: number) => string
> = {
  editedFiles: (count) => `编辑了 ${count} 个文件`,
  readFiles: (count) => `读取了 ${count} 个文件`,
  ranCommands: (count) => `执行了 ${count} 条命令`,
  searchedFiles: (count) => `搜索了 ${count} 个文件`,
  usedBrowser: () => "使用了浏览器",
  loadedTools: (count) => `加载了 ${count} 个工具`,
  createdFiles: (count) => `创建了 ${count} 个文件`,
  createdVisualizations: (count) => `创建了 ${count} 个可视化`,
  coordinatedAgents: (count) => `协调了 ${count} 个 Agent`,
};

export function formatWorkActivitySummary(
  items: readonly WorkActivitySummaryItem[],
  language = "en",
): string {
  if (items.length === 0) return "";

  if (language.toLowerCase().startsWith("zh")) {
    return items
      .map(({ category, count }) => CHINESE_ACTIVITY_PHRASES[category](count))
      .join("、");
  }

  const text = items
    .map(({ category, count }) => ENGLISH_ACTIVITY_PHRASES[category](count))
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
