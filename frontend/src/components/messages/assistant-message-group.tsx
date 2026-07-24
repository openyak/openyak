"use client";

import { memo, useMemo } from "react";
import { AssistantMessage } from "./assistant-message";
import type { MessageResponse, PartData } from "@/types/message";

interface AssistantMessageGroupProps {
  messages: MessageResponse[];
  /** Whether this group just arrived (animate) or was loaded from history (skip animation). */
  isNew?: boolean;
}

/**
 * Renders a group of consecutive assistant messages as a single visual block.
 *
 * The backend creates a separate assistant message per agent step, but from
 * the user's perspective these are all one response. This component combines
 * all parts from all messages and renders them through a single AssistantMessage.
 */
export const AssistantMessageGroup = memo(function AssistantMessageGroup({ messages, isNew = true }: AssistantMessageGroupProps) {
  const combinedParts = useMemo(
    () =>
      messages.flatMap((msg) =>
        msg.parts.map((p) => p.data as PartData),
      ),
    [messages],
  );

  // Use the first message as the "representative" for the group
  return (
    <div className="px-4 py-4">
      <div
        className="conversation-rail mx-auto"
        data-conversation-rail
      >
        <AssistantMessage
          message={messages[0]}
          combinedParts={combinedParts}
          isNew={isNew}
        />
      </div>
    </div>
  );
});
