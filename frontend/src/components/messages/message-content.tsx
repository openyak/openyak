"use client";

import { useCallback, useMemo, useState } from "react";
import type { PartData, ToolPart, StepStartPart, StepFinishPart } from "@/types/message";
import { TextPart } from "@/components/parts/text-part";
import { ReasoningPart } from "@/components/parts/reasoning-part";
import { SubtaskPart } from "@/components/parts/subtask-part";
import { ArtifactCard } from "@/components/parts/artifact-card";
import { PlanFileCard } from "@/components/parts/plan-file-card";
import { SourcesFooter } from "@/components/parts/sources-footer";
import { ActivitySummary } from "@/components/activity/activity-summary";
import { TodoProgress, type TodoItem } from "@/components/parts/todo-progress";
import { extractSources } from "@/lib/sources";
import type { ActivityData, ChainItem } from "@/stores/activity-store";

interface MessageContentProps {
  parts: PartData[];
  /** Whether this is the currently streaming message. */
  isStreaming?: boolean;
  /** Stable key identifying the message — used by ActivitySummary to toggle the activity panel. */
  activityKey?: string;
}

/**
 * Content Parts Dispatcher — routes each part to the appropriate renderer.
 *
 * When streaming: reasoning + tools are folded into a single "Thinking" line.
 * When complete: reasoning + tools are folded into a single "Activity" summary.
 */
export function MessageContent({ parts, isStreaming, activityKey }: MessageContentProps) {
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

  // Collect all reasoning texts into a single array
  const reasoningTexts = useMemo(
    () =>
      parts
        .filter((p): p is PartData & { type: "reasoning" } => p.type === "reasoning")
        .map((p) => p.text),
    [parts],
  );

  const toolParts = useMemo(
    () => parts.filter((p): p is ToolPart => p.type === "tool"),
    [parts],
  );

  const stepParts = useMemo(
    () =>
      parts.filter(
        (p): p is StepStartPart | StepFinishPart =>
          p.type === "step-start" || p.type === "step-finish",
      ),
    [parts],
  );

  const hasReasoning = reasoningTexts.length > 0;
  const hasTools = toolParts.length > 0;
  const hasActivity = hasReasoning || hasTools;

  // Only show activity during streaming if there's meaningful content:
  // - At least one reasoning text with non-empty firstLine, OR
  // - At least one tool part (running or completed)
  const hasMeaningfulActivity = useMemo(() => {
    if (!hasActivity) return false;
    if (!isStreaming) return true; // Always show when message is complete

    // During streaming: check for meaningful content
    const hasReasoningContent = reasoningTexts.some(text => {
      // Mirror the firstLine extraction from reasoning-part.tsx:45
      const firstLine = text?.split(/[。.!\n]/)[0]?.trim() ?? "";
      return firstLine.length > 0;
    });

    return hasReasoningContent || toolParts.length > 0;
  }, [hasActivity, isStreaming, reasoningTexts, toolParts]);

  // Track whether the thinking section is still active (reasoning or tools running)
  // Build ordered chain from parts (preserves interleaving of reasoning + tools)
  const chain = useMemo<ChainItem[]>(() => {
    const items: ChainItem[] = [];
    for (const p of parts) {
      if (p.type === "reasoning") items.push({ type: "reasoning", text: (p as PartData & { type: "reasoning" }).text });
      else if (p.type === "tool") items.push({ type: "tool", data: p as ToolPart });
    }
    return items;
  }, [parts]);

  // Activity data for the summary/panel
  const activityData = useMemo<ActivityData | null>(
    () =>
      hasActivity
        ? {
            sourceKey: activityKey,
            reasoningTexts,
            toolParts,
            thinkingDuration,
            stepParts,
            hasVisibleOutput: parts.some((p) =>
              p.type === "text" || p.type === "file" || p.type === "compaction" || p.type === "subtask",
            ),
            chain,
          }
        : null,
    [hasActivity, reasoningTexts, toolParts, thinkingDuration, stepParts, chain, parts, activityKey],
  );

  // Content parts: text, subtask, and artifact tool calls (shown as inline cards)
  // Exclude error-status artifact calls (e.g. failed update attempts) — they have no content to display
  const contentParts = useMemo(
    () =>
      parts.filter(
        (p) =>
          p.type !== "compaction" &&
          p.type !== "reasoning" &&
          p.type !== "step-start" &&
          p.type !== "step-finish" &&
          !(p.type === "tool" && (p as ToolPart).tool !== "artifact" && (p as ToolPart).tool !== "submit_plan") &&
          !(p.type === "tool" && (p as ToolPart).tool === "artifact" && (p as ToolPart).state.status === "error"),
      ),
    [parts],
  );

  // Extract sources from web_search / web_fetch tool parts for citation rendering
  const sources = useMemo(() => extractSources(parts), [parts]);

  // Extract latest todo list from the most recent todo tool call
  const latestTodos = useMemo<TodoItem[]>(() => {
    for (let i = toolParts.length - 1; i >= 0; i--) {
      const tp = toolParts[i];
      if (tp.tool === "todo" && tp.state.metadata?.todos) {
        return tp.state.metadata.todos as TodoItem[];
      }
    }
    return [];
  }, [toolParts]);

  return (
    <div className="space-y-3">
      {/* Reasoning + tools: only show inline while streaming */}
      {isStreaming && hasActivity && hasMeaningfulActivity && (
        <ReasoningPart
          texts={reasoningTexts}
          toolParts={toolParts}
          isStreaming={isStreaming}
          onDurationChange={handleDurationChange}
        />
      )}

      {/* Activity summary — replaces ReasoningPart once streaming is done */}
      {!isStreaming && activityData && <ActivitySummary data={activityData} />}

      {/* Todo progress — visible only while streaming, folds into activity summary when done */}
      {isStreaming && latestTodos.length > 0 && <TodoProgress todos={latestTodos} />}

      {/* Content parts (text, subtask, artifacts) */}
      {contentParts.map((part) => {
        const originalIndex = parts.indexOf(part);
        switch (part.type) {
          case "text":
            return (
              <TextPart
                key={originalIndex}
                data={part}
                isStreaming={isStreaming && originalIndex === lastTextIndex}
                sources={sources}
              />
            );
          case "subtask":
            return <SubtaskPart key={originalIndex} data={part} />;
          case "tool": {
            const tp = part as ToolPart;
            if (tp.tool === "submit_plan") return <PlanFileCard key={originalIndex} data={tp} />;
            return <ArtifactCard key={originalIndex} data={tp} />;
          }
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
