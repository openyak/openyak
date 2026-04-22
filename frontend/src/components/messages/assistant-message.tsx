"use client";

import { useState, useMemo, memo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { MessageContent } from "./message-content";
import { MessageActions } from "./message-actions";
import { CompactionPart } from "@/components/parts/compaction-part";
import { useChatStore } from "@/stores/chat-store";
import { useActivityStore } from "@/stores/activity-store";
import { extractTextFromParts } from "@/lib/utils";
import type { MessageResponse, PartData, ToolPart, StepStartPart, StepFinishPart, CompactionPart as CompactionPartType } from "@/types/message";
import { computeDuration, type ActivityData, type ChainItem } from "@/stores/activity-store";

interface AssistantMessageProps {
  message: MessageResponse;
  /** Pre-combined parts from grouped consecutive assistant messages. */
  combinedParts?: PartData[];
  onRegenerate?: () => void;
  /** Whether this message just arrived (animate) or was loaded from history (skip animation). */
  isNew?: boolean;
}

export function AssistantMessage({ message, combinedParts, onRegenerate, isNew = true }: AssistantMessageProps) {
  const [hovered, setHovered] = useState(false);
  const refreshForMessage = useActivityStore((s) => s.refreshForMessage);
  const parts = combinedParts ?? message.parts.map((p) => p.data as PartData);
  const mainParts = useMemo(
    () => parts.filter((part) => part.type !== "compaction"),
    [parts],
  );
  const compactionParts = useMemo(
    () => parts.filter((part): part is CompactionPartType => part.type === "compaction"),
    [parts],
  );
  const activityKey = message.id;

  // Extract text content for copy
  const textContent = extractTextFromParts(mainParts);

  // Build activity data from parts
  const activityData = useMemo<ActivityData | null>(() => {
    const reasoningTexts = mainParts
      .filter((p): p is PartData & { type: "reasoning" } => p.type === "reasoning")
      .map((p) => p.text);
    const toolParts = mainParts.filter((p): p is ToolPart => p.type === "tool");
    const stepParts = mainParts.filter(
      (p): p is StepStartPart | StepFinishPart =>
        p.type === "step-start" || p.type === "step-finish",
    );

    if (reasoningTexts.length === 0 && toolParts.length === 0) return null;

    const chain: ChainItem[] = [];
    for (const p of mainParts) {
      if (p.type === "reasoning") chain.push({ type: "reasoning", text: (p as PartData & { type: "reasoning" }).text });
      else if (p.type === "tool") chain.push({ type: "tool", data: p as ToolPart });
    }

    const data: ActivityData = {
      sourceKey: activityKey,
      reasoningTexts,
      toolParts,
      stepParts,
      hasVisibleOutput: mainParts.some((p) =>
        p.type === "text" || p.type === "file" || p.type === "subtask",
      ),
      chain,
    };
    data.thinkingDuration = computeDuration(data);
    return data;
  }, [activityKey, mainParts]);

  useEffect(() => {
    if (activityData) {
      refreshForMessage(activityKey, activityData);
    }
  }, [activityData, activityKey, refreshForMessage]);

  return (
    <>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <motion.div
          initial={isNew ? { opacity: 0, y: 6 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 30,
            opacity: { duration: 0.2 },
          }}
        >
          <MessageContent parts={mainParts} activityKey={activityKey} />
        </motion.div>

        {/* Action bar — always in DOM to avoid layout shift, opacity-only toggle */}
        <div
          className={`transition-opacity duration-150 ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <MessageActions
            content={textContent}
            onRegenerate={onRegenerate}
            activityData={activityData}
            activityKey={activityKey}
          />
        </div>
      </div>

      {compactionParts.length > 0 && (
        <div className="mt-4 space-y-2">
          {compactionParts.map((part, index) => (
            <CompactionPart key={`${activityKey}-compaction-${index}`} data={part} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Streaming assistant message — renders live parts being accumulated.
 */
interface StreamingMessageProps {
  parts: PartData[];
  streamingText: string;
  streamingReasoning: string;
}

export const StreamingMessage = memo(function StreamingMessage({ parts, streamingText, streamingReasoning }: StreamingMessageProps) {
  const { t } = useTranslation("chat");
  const isModelLoading = useChatStore((s) => s.isModelLoading);

  // Stabilize liveParts reference — without useMemo, a new array is created
  // on every render, breaking downstream useMemo dependencies in MessageContent.
  const liveParts = useMemo(() => {
    const result: PartData[] = [...parts];
    if (streamingReasoning) result.push({ type: "reasoning", text: streamingReasoning });
    if (streamingText) result.push({ type: "text", text: streamingText });
    return result;
  }, [parts, streamingReasoning, streamingText]);

  // No content yet — show blinking cursor to indicate "about to type"
  if (liveParts.length === 0) {
    return (
      <div className="animate-fade-in">
        <StreamingStage label={t("stageThinking")} />
        <StreamingIndicator />
      </div>
    );
  }

  // Check if there's active text/reasoning streaming.
  // If not, the agent is in a "quiet" phase (e.g., executing tool after
  // permission, waiting between steps) — show a trailing indicator.
  const isActivelyStreaming = !!streamingText || !!streamingReasoning;
  const hasAnyTool = liveParts.some((p) => p.type === "tool");
  const hasAnyActivity = liveParts.some((p) => p.type === "reasoning" || p.type === "tool");
  // Also check if the last tool is still running
  const lastPart = liveParts[liveParts.length - 1];
  const hasRunningTool =
    lastPart?.type === "tool" && lastPart.state?.status === "running";
  // Check if the last step finished with a terminal reason (LLM is done,
  // just waiting for DONE event — e.g. during title generation).
  const lastStepFinish = [...liveParts].reverse().find((p) => p.type === "step-finish") as
    | (PartData & { type: "step-finish"; reason?: string }) | undefined;
  const isGenerationDone = !!lastStepFinish && lastStepFinish.reason !== "tool_use";
  const showTail = !isActivelyStreaming && !hasRunningTool && !isGenerationDone;

  let stageLabel = t("stageThinking");
  if (hasRunningTool) stageLabel = t("stageWorkingWithTools");
  else if (!isActivelyStreaming && hasAnyTool) stageLabel = t("stageFinalizing");

  return (
    <div className="animate-fade-in">
      {!hasAnyActivity && <StreamingStage label={isModelLoading ? t("stageThinking") : stageLabel} />}
      <MessageContent parts={liveParts} isStreaming />
      {showTail && (
        <div className="mt-2">
          <StreamingIndicator label={stageLabel} />
        </div>
      )}
    </div>
  );
});

function StreamingStage({ label }: { label: string }) {
  return (
    <div
      className="mb-2 flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]"
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)] animate-[pulse-dot_1.4s_ease-in-out_infinite]"
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

/** Animated dots — shown while waiting for or between output (Claude.ai style). */
function StreamingIndicator({ label = "Thinking" }: { label?: string }) {
  return (
    <div className="flex items-center gap-1 py-3" role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)] animate-[pulse-dot_1.4s_ease-in-out_infinite]"
          style={{ animationDelay: `${i * 0.2}s` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
