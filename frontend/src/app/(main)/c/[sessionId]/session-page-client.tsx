"use client";

import { useLayoutEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ChatView } from "@/components/chat/chat-view";
import { SubagentsWorkView } from "@/components/subagents/subagents-page";
import { resolveSessionId } from "@/lib/routes";

interface SessionPageClientProps {
  sessionId?: string | null;
}

export function SessionPageClient({ sessionId: providedSessionId }: SessionPageClientProps = {}) {
  const params = useParams<{ sessionId?: string | string[] }>();
  const searchParams = useSearchParams();
  const routeSessionId = Array.isArray(params.sessionId)
    ? params.sessionId[0]
    : params.sessionId;
  const querySessionId = searchParams.get("sessionId");
  const sessionId = providedSessionId ?? resolveSessionId(routeSessionId ?? null, querySessionId);
  const workView = searchParams.get("view");
  const selectedChildSessionId = searchParams.get("child");
  const showSubagents = !!sessionId && workView === "subagents";
  const wasShowingSubagents = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (showSubagents && !wasShowingSubagents.current) {
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        activeElement !== document.body
      ) {
        returnFocusRef.current = activeElement;
      }
    } else if (!showSubagents && wasShowingSubagents.current) {
      const returnTarget = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) {
          returnTarget.focus();
        }
      });
      returnFocusRef.current = null;
    }
    wasShowingSubagents.current = showSubagents;
  }, [showSubagents]);

  if (!sessionId) return null;

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div
        className={`h-full min-h-0${showSubagents ? " invisible pointer-events-none" : ""}`}
        aria-hidden={showSubagents || undefined}
      >
        <ChatView sessionId={sessionId} />
      </div>
      {showSubagents && (
        <div className="absolute inset-0 z-20">
          <SubagentsWorkView
            parentSessionId={sessionId}
            selectedSessionId={selectedChildSessionId}
          />
        </div>
      )}
    </div>
  );
}
