"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { PartData, ToolPart, StepStartPart, StepFinishPart } from "@/types/message";
import { TextPart } from "@/components/parts/text-part";
import { ReasoningPart } from "@/components/parts/reasoning-part";
import { CompactionPart } from "@/components/parts/compaction-part";
import { SubtaskPart } from "@/components/parts/subtask-part";
import { SwarmPart } from "@/components/parts/swarm-part";
import { ArtifactCard } from "@/components/parts/artifact-card";
import { FileArtifactCard } from "@/components/parts/file-artifact-card";
import { PlanFileCard } from "@/components/parts/plan-file-card";
import { SourcesFooter } from "@/components/parts/sources-footer";
import { ActivitySummary } from "@/components/activity/activity-summary";
import { TodoProgress, type TodoItem } from "@/components/parts/todo-progress";
import { extractSources } from "@/lib/sources";
import { cn } from "@/lib/utils";
import {
  buildWorkEventTimeline,
  type WorkActivityEvent,
} from "@/lib/work-event-timeline";
import type { ActivityData, ChainItem } from "@/stores/activity-store";

interface MessageContentProps {
  parts: PartData[];
  /** Parent task that owns child-agent parts in this message. */
  parentSessionId?: string | null;
  /** Whether this is the currently streaming message. */
  isStreaming?: boolean;
  /** Stable key identifying the message — used by ActivitySummary to toggle the activity panel. */
  activityKey?: string;
}

const VISIBLE_TOOL_PARTS = new Set(["artifact", "present_file", "submit_plan"]);
const FILE_CARD_TOOL_PARTS = new Set(["present_file", "write", "edit", "code_execute"]);
const GENERATED_FILE_TOOL_PARTS = new Set(["write", "edit", "code_execute"]);
const FILE_CARD_EXTENSIONS = new Set([
  ".csv",
  ".docx",
  ".html",
  ".htm",
  ".md",
  ".mdx",
  ".pdf",
  ".ppt",
  ".pptx",
  ".svg",
  ".tsv",
  ".txt",
  ".xls",
  ".xlsx",
]);
const NON_USER_FACING_FILE_HINTS = ["helper", "scratch", "temp", "tmp", "script"];

function isFileCardToolPart(part: PartData): boolean {
  return part.type === "tool" && FILE_CARD_TOOL_PARTS.has((part as ToolPart).tool);
}

function fileExtension(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const fileName = filePath.slice(lastSlash + 1);
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

function isUserFacingGeneratedFile(filePath: string): boolean {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const fileName = filePath.slice(lastSlash + 1).toLowerCase();
  if (!FILE_CARD_EXTENSIONS.has(fileExtension(filePath))) return false;
  return !NON_USER_FACING_FILE_HINTS.some((hint) => fileName.includes(hint));
}

function collectToolFilePaths(part: ToolPart): string[] {
  const input = part.state.input as Record<string, unknown>;
  const metadata = (part.state.metadata ?? {}) as Record<string, unknown>;

  if (part.tool === "present_file") {
    const filePath = metadata.file_path || input.file_path;
    return typeof filePath === "string" ? [filePath] : [];
  }

  if ((part.tool === "write" || part.tool === "edit") && typeof metadata.file_path === "string") {
    return [metadata.file_path];
  }

  if (part.tool === "code_execute" && Array.isArray(metadata.written_files)) {
    return metadata.written_files.filter((path): path is string => typeof path === "string");
  }

  return [];
}

function fileCardsForTool(part: ToolPart, presentedFilePaths: Set<string>) {
  const input = part.state.input as Record<string, unknown>;
  const metadata = (part.state.metadata ?? {}) as Record<string, unknown>;
  const title =
    typeof metadata.title === "string"
      ? metadata.title
      : typeof input.title === "string"
        ? input.title
        : undefined;

  return collectToolFilePaths(part)
    .filter((filePath) =>
      part.tool === "present_file"
        ? !!filePath
        : isUserFacingGeneratedFile(filePath) && !presentedFilePaths.has(filePath),
    )
    .map((filePath) => ({ filePath, title: part.tool === "present_file" ? title : undefined }));
}

/**
 * Content Parts Dispatcher — routes each part to the appropriate renderer.
 *
 * When streaming: reasoning + tools are folded into a single "Thinking" line.
 * When complete: reasoning + tools are folded into a single "Activity" summary.
 */
export function MessageContent({
  parts,
  parentSessionId,
  isStreaming,
  activityKey,
}: MessageContentProps) {
  // Thinking duration reported by ReasoningPart's live timer
  const [thinkingDuration, setThinkingDuration] = useState<number | undefined>();
  const handleDurationChange = useCallback((secs: number) => setThinkingDuration(secs), []);

  // Find the last text part index to pass isStreaming only to that one
  let lastTextIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === "text" && lastTextIndex === -1) {
      lastTextIndex = i;
      break;
    }
  }
  const hasVisibleWorkAfterLastText =
    lastTextIndex >= 0 &&
    parts.slice(lastTextIndex + 1).some((part) =>
      part.type === "reasoning" ||
      part.type === "tool" ||
      part.type === "subtask" ||
      part.type === "swarm" ||
      part.type === "compaction",
    );

  const timeline = useMemo(() => buildWorkEventTimeline(parts), [parts]);
  const toolParts = useMemo(
    () => parts.filter((p): p is ToolPart => p.type === "tool"),
    [parts],
  );

  const presentedFilePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const part of toolParts) {
      if (part.tool !== "present_file") continue;
      for (const filePath of collectToolFilePaths(part)) {
        paths.add(filePath);
      }
    }
    return paths;
  }, [toolParts]);

  // Extract sources from web_search / web_fetch tool parts for citation rendering
  const sources = useMemo(() => extractSources(parts), [parts]);

  // Keep the latest progress list beside the activity batch that produced it.
  const latestTodo = useMemo<{ callId: string; todos: TodoItem[] } | null>(() => {
    for (let i = toolParts.length - 1; i >= 0; i--) {
      const tp = toolParts[i];
      if (tp.tool === "todo" && tp.state.metadata?.todos) {
        return {
          callId: tp.call_id,
          todos: tp.state.metadata.todos as TodoItem[],
        };
      }
    }
    return null;
  }, [toolParts]);

  const renderActivityOutputs = (
    batchTools: ToolPart[],
    eventStartIndex: number,
  ): ReactNode[] => {
    const outputTools = batchTools.filter(
      (tool) =>
        !(
          tool.tool === "artifact" &&
          tool.state.status === "error"
        ) &&
        (VISIBLE_TOOL_PARTS.has(tool.tool) ||
          (GENERATED_FILE_TOOL_PARTS.has(tool.tool) &&
            fileCardsForTool(tool, presentedFilePaths).length > 0)),
    );
    const output: ReactNode[] = [];

    for (let index = 0; index < outputTools.length; index += 1) {
      const tool = outputTools[index];

      if (isFileCardToolPart(tool)) {
        const group: Array<{
          filePath: string;
          title?: string;
          source: ToolPart;
        }> = [];
        const seen = new Set<string>();
        let groupEnd = index;

        while (
          groupEnd < outputTools.length &&
          isFileCardToolPart(outputTools[groupEnd])
        ) {
          const candidate = outputTools[groupEnd];
          for (const item of fileCardsForTool(candidate, presentedFilePaths)) {
            if (seen.has(item.filePath)) continue;
            seen.add(item.filePath);
            group.push({ ...item, source: candidate });
          }
          groupEnd += 1;
        }
        index = groupEnd - 1;

        if (group.length > 0) {
          output.push(
            <div
              key={`file-group-${eventStartIndex}-${tool.call_id}`}
              className={cn(
                "grid gap-2",
                group.length > 1 && "sm:grid-cols-2",
              )}
            >
              {group.map((item) => (
                <FileArtifactCard
                  key={`${item.source.call_id}-${item.filePath}`}
                  data={item.source}
                  filePath={item.filePath}
                  title={item.title}
                  cardId={`file-card-${item.source.call_id}-${item.filePath}`}
                  compact={group.length > 1}
                />
              ))}
            </div>,
          );
        }
        continue;
      }

      if (tool.tool === "submit_plan") {
        output.push(<PlanFileCard key={tool.call_id} data={tool} />);
      } else if (tool.tool === "artifact") {
        output.push(<ArtifactCard key={tool.call_id} data={tool} />);
      }
    }

    return output;
  };

  const renderActivityEvent = (
    event: WorkActivityEvent,
    eventIndex: number,
  ) => {
    const reasoningTexts = event.parts
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text);
    const batchTools = event.parts.filter(
      (part): part is ToolPart => part.type === "tool",
    );
    if (reasoningTexts.length === 0 && batchTools.length === 0) return null;

    const stepParts = event.parts.filter(
      (part): part is StepStartPart | StepFinishPart =>
        part.type === "step-start" || part.type === "step-finish",
    );
    const chain: ChainItem[] = [];
    for (const part of event.parts) {
      if (part.type === "reasoning") {
        chain.push({ type: "reasoning", text: part.text });
      } else if (part.type === "tool") {
        chain.push({ type: "tool", data: part });
      }
    }
    const terminalStep = [...stepParts]
      .reverse()
      .find(
        (part): part is StepFinishPart =>
          part.type === "step-finish" && part.reason !== "tool_use",
      );
    const isLiveBatch =
      !!isStreaming &&
      eventIndex === timeline.length - 1 &&
      !terminalStep;
    const hasReasoningContent = reasoningTexts.some(
      (text) => (text?.split(/[。.!\n]/)[0]?.trim() ?? "").length > 0,
    );
    const data: ActivityData = {
      sourceKey: activityKey
        ? `${activityKey}:activity:${event.startIndex}`
        : undefined,
      reasoningTexts,
      toolParts: batchTools,
      thinkingDuration,
      stepParts,
      hasVisibleOutput:
        batchTools.some((tool) => VISIBLE_TOOL_PARTS.has(tool.tool)) ||
        batchTools.some(
          (tool) =>
            GENERATED_FILE_TOOL_PARTS.has(tool.tool) &&
            fileCardsForTool(tool, presentedFilePaths).length > 0,
        ),
      chain,
    };
    const activityOutput = renderActivityOutputs(
      batchTools,
      event.startIndex,
    );
    const showsLatestTodo =
      !!isStreaming &&
      !!latestTodo &&
      batchTools.some((tool) => tool.call_id === latestTodo.callId);

    return (
      <div
        key={`activity-${event.startIndex}`}
        className="space-y-3"
        data-work-event="activity"
      >
        {isLiveBatch && (hasReasoningContent || batchTools.length > 0) ? (
          <ReasoningPart
            texts={reasoningTexts}
            toolParts={batchTools}
            isStreaming
            onDurationChange={handleDurationChange}
          />
        ) : (
          <ActivitySummary data={data} completed />
        )}
        {showsLatestTodo && <TodoProgress todos={latestTodo.todos} />}
        {activityOutput}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {timeline.map((event, eventIndex) => {
        if (event.type === "activity") {
          return renderActivityEvent(event, eventIndex);
        }

        const { part, index } = event;
        switch (part.type) {
          case "text":
            return (
              <TextPart
                key={`text-${index}`}
                data={part}
                isStreaming={
                  isStreaming &&
                  index === lastTextIndex &&
                  !hasVisibleWorkAfterLastText
                }
                sources={sources}
              />
            );
          case "compaction":
            return (
              <CompactionPart
                key={`compaction-${index}`}
                data={part}
              />
            );
          case "subtask":
            return (
              <SubtaskPart
                key={`subtask-${index}`}
                data={part}
                parentSessionId={parentSessionId}
              />
            );
          case "swarm":
            return <SwarmPart key={`swarm-${index}`} data={part} />;
          default:
            return null;
        }
      })}

      {/* Sources footer — shown progressively as tool results arrive */}
      {sources.length > 0 && (
        <SourcesFooter sources={sources} />
      )}
    </div>
  );
}
