"use client";

import { useMemo, useRef, useEffect, useCallback, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useScrollAnchor } from "@/hooks/use-scroll-anchor";
import { MessageItem } from "./message-item";
import { AssistantMessageGroup } from "./assistant-message-group";
import { StreamingMessage } from "./assistant-message";
import { FileChip } from "@/components/chat/file-chip";
import { Skeleton } from "@/components/ui/skeleton";
import type { FileAttachment } from "@/types/chat";
import { extractTextFromPartResponses } from "@/lib/utils";
import type { MessageResponse, PartData } from "@/types/message";

/** A user message or a group of consecutive assistant messages. */
type MessageGroup =
  | { kind: "user"; message: MessageResponse }
  | { kind: "assistant"; messages: MessageResponse[] };

/**
 * Group consecutive assistant messages into a single visual block.
 *
 * The backend creates a separate assistant message for each agent step,
 * but the user expects to see a single response per prompt.
 */
function groupMessages(messages: MessageResponse[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let assistantBatch: MessageResponse[] = [];

  const flushBatch = () => {
    if (assistantBatch.length > 0) {
      groups.push({ kind: "assistant", messages: assistantBatch });
      assistantBatch = [];
    }
  };

  for (const msg of messages) {
    if (msg.data.role === "assistant") {
      assistantBatch.push(msg);
    } else if (
      msg.data.role === "user" &&
      (msg.data as unknown as Record<string, unknown>).system
    ) {
      // System-injected user messages (continuations, nudges) are invisible
      // and must NOT break the assistant message grouping.
      continue;
    } else {
      flushBatch();
      groups.push({ kind: "user", message: msg });
    }
  }
  flushBatch();

  return groups;
}

interface MessageListProps {
  messages: MessageResponse[];
  isLoading: boolean;
  isGenerating: boolean;
  /** Stream ID — only set after the backend confirms the generation. */
  streamId: string | null;
  /** Optimistic user message text shown before the API confirms. */
  pendingUserText: string | null;
  /** Attachments for the optimistic user bubble. */
  pendingAttachments?: FileAttachment[] | null;
  streamingParts: PartData[];
  streamingText: string;
  streamingReasoning: string;
  /** Callback to edit a user message and re-generate from that point. */
  onEditAndResend?: (messageId: string, newText: string, attachments?: FileAttachment[]) => Promise<boolean>;
  /** Whether there are older messages to load. */
  hasPreviousPage?: boolean;
  /** Whether older messages are currently being fetched. */
  isFetchingPreviousPage?: boolean;
  /** Fetch the next batch of older messages. */
  fetchPreviousPage?: () => void;
}

export function MessageList({
  messages,
  isLoading,
  isGenerating,
  streamId,
  pendingUserText,
  pendingAttachments,
  streamingParts,
  streamingText,
  streamingReasoning,
  onEditAndResend,
  hasPreviousPage,
  isFetchingPreviousPage,
  fetchPreviousPage,
}: MessageListProps) {
  const { scrollRef, scrollElementRef, bottomRef, isAtBottom, scrollToBottom } = useScrollAnchor();
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  // Keep StreamingMessage visible briefly after generation finishes so the
  // DB-fetched AssistantMessageGroup has time to render. Without this,
  // there's a 1-frame blank flash between StreamingMessage unmounting and
  // the DB messages mounting.
  const wasGeneratingRef = useRef(false);
  const prevMessageCountRef = useRef(messages?.length ?? 0);
  const [showStreamingFallback, setShowStreamingFallback] = useState(false);

  useEffect(() => {
    if (isGenerating) {
      wasGeneratingRef.current = true;
      prevMessageCountRef.current = messages?.length ?? 0;
      setShowStreamingFallback(false);
    } else if (wasGeneratingRef.current) {
      wasGeneratingRef.current = false;
      setShowStreamingFallback(true);
      const timer = setTimeout(() => setShowStreamingFallback(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [isGenerating]);

  useEffect(() => {
    if (showStreamingFallback && (messages?.length ?? 0) > prevMessageCountRef.current) {
      setShowStreamingFallback(false);
    }
  }, [messages?.length, showStreamingFallback]);

  // Reverse infinite scroll: observe top sentinel to load older messages
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollElementRef.current;
    if (!sentinel || !container || !hasPreviousPage || isFetchingPreviousPage) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasPreviousPage && !isFetchingPreviousPage) {
          // Save scroll height before prepending for scroll position restoration
          const prevHeight = container.scrollHeight;
          fetchPreviousPage?.();
          // After DOM updates, restore scroll position
          requestAnimationFrame(() => {
            const newHeight = container.scrollHeight;
            container.scrollTop += newHeight - prevHeight;
          });
        }
      },
      { root: container, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage, scrollElementRef]);

  // Track known message IDs to distinguish historical vs new messages.
  // Messages present on first render (or first data load) are "old" — skip animation.
  // Messages that appear later are "new" — animate in.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const initialLoadDoneRef = useRef(false);

  // On first non-loading render with messages, seed the known IDs set
  useEffect(() => {
    if (!isLoading && messages.length > 0 && !initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      knownIdsRef.current = new Set(messages.map((m) => m.id));
    }
  }, [isLoading, messages]);

  // Build a set of "new" message IDs (messages not in the initial set)
  const newMessageIds = useMemo(() => {
    if (!initialLoadDoneRef.current) return new Set<string>();
    const newIds = new Set<string>();
    for (const msg of messages) {
      if (!knownIdsRef.current.has(msg.id)) {
        newIds.add(msg.id);
        knownIdsRef.current.add(msg.id);
      }
    }
    return newIds;
  }, [messages]);

  // Reset unread count when user scrolls to bottom
  useEffect(() => {
    if (isAtBottom) setUnreadCount(0);
  }, [isAtBottom]);

  // Increment unread count when new messages arrive while scrolled up
  const prevMsgLenRef = useRef(messages.length);
  useEffect(() => {
    const prevLen = prevMsgLenRef.current;
    prevMsgLenRef.current = messages.length;
    if (messages.length > prevLen && !isAtBottom) {
      setUnreadCount((c) => c + (messages.length - prevLen));
    }
  }, [messages.length, isAtBottom]);

  // Group consecutive assistant messages so multi-step responses render as one block
  // Regroup whenever message content changes. Parts can be appended to existing
  // message IDs during/after generation, so depending only on length/last-id can
  // leave stale groups that miss the final assistant text until a full refresh.
  const groups = useMemo(
    () => groupMessages(messages),
    [messages]
  );

  // The shell message only exists after the backend created it (streamId is set).
  // During beginSending (streamId is null), we must NOT hide the previous response.
  const hasActiveStream = !!streamId;

  // Don't show the optimistic user bubble if the DB-fetched messages already
  // contain a matching user message. This prevents duplicates after navigating
  // from /c/new to /c/{sessionId} (where useMessages fetches the persisted
  // user message while pendingUserText is still set in the global store).
  const showPendingBubble = useMemo(() => {
    if (!pendingUserText) return false;
    if (messages.length === 0) return true;
    const hasPendingInDb = messages.some((m) => {
      if ((m.data as { role: string }).role !== "user") return false;
      const fullText = extractTextFromPartResponses(m.parts);
      return fullText.includes(pendingUserText);
    });
    return !hasPendingInDb;
  }, [pendingUserText, messages]);

  // Only show the loading state on the very first load (no cached/placeholder data).
  // When switching sessions with keepPreviousData, messages.length > 0 so we
  // skip the skeleton and render the (placeholder) messages for a seamless transition.
  const isFirstLoad = isLoading && messages.length === 0;

  if (isFirstLoad) {
    // When generating, skip skeletons and show the streaming message directly
    // to avoid a jarring skeleton → content transition during page navigation
    if (isGenerating || !!streamId) {
      return (
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto overscroll-contain scrollbar-auto">
          {/* Show optimistic user bubble during loading so it doesn't flash
              away between navigation and message fetch completion */}
          {pendingUserText && (
            <div className="px-4 py-3">
              <div className="mx-auto max-w-3xl xl:max-w-4xl">
                <div className="flex justify-end">
                  <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl bg-[var(--user-bubble-bg)] px-4 py-2.5 shadow-[var(--shadow-sm)] border border-[var(--border-default)]">
                    <div className="text-[15px] text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">
                      {pendingUserText}
                    </div>
                    {pendingAttachments && pendingAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {pendingAttachments.map((att) => (
                          <FileChip key={att.file_id} file={att} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="px-4 py-5">
            <div className="mx-auto max-w-3xl xl:max-w-4xl">
              <StreamingMessage
                parts={streamingParts}
                streamingText={streamingText}
                streamingReasoning={streamingReasoning}
              />
            </div>
          </div>
          <div ref={bottomRef} className="h-px" />
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div
          className="mx-auto max-w-3xl xl:max-w-4xl space-y-6 animate-fade-in"
          style={{ animationDelay: "150ms", animationFillMode: "backwards" }}
        >
          {/* User message skeleton — right aligned */}
          <div className="flex justify-end">
            <Skeleton className="h-10 w-48 rounded-2xl" />
          </div>
          {/* Assistant message skeleton — left aligned */}
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
          {/* Second pair */}
          <div className="flex justify-end">
            <Skeleton className="h-10 w-64 rounded-2xl" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain scrollbar-auto">
        {/* Top sentinel for reverse infinite scroll */}
        <div ref={topSentinelRef} className="h-px" />
        {isFetchingPreviousPage && (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
          </div>
        )}

        {messages.length === 0 && !isGenerating ? (
          <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
            No messages yet
          </div>
        ) : (
          <>
            {groups.map((group) => {
              if (group.kind === "user") {
                return (
                  <MessageItem
                    key={group.message.id}
                    message={group.message}
                    isNew={newMessageIds.has(group.message.id)}
                    onEditAndResend={onEditAndResend}
                    isGenerating={isGenerating}
                  />
                );
              }

              // Assistant group — hide the entire last group during active
              // streaming ONLY if it belongs to the current generation.
              // The StreamingMessage component handles rendering all accumulated
              // content. Without this, a race condition can cause DB-fetched
              // messages (with partially-populated parts) to render alongside
              // the StreamingMessage, producing duplicate blocks.
              //
              // However, if `showPendingBubble` is true, the user just sent a
              // new message that isn't yet in the DB cache — meaning the last
              // assistant group is from a PREVIOUS turn. Don't hide it or the
              // previous AI response disappears when a follow-up is sent.
              const lastMsg = group.messages[group.messages.length - 1];
              const isLastOverall =
                messages.length > 0 && lastMsg.id === messages[messages.length - 1].id;

              // Check if any message in the group is new
              const groupIsNew = group.messages.some((m) => newMessageIds.has(m.id));

              if ((hasActiveStream || showStreamingFallback) && isLastOverall && !showPendingBubble) {
                return null;
              }

              return (
                <AssistantMessageGroup
                  key={group.messages[0].id}
                  messages={group.messages}
                  isNew={groupIsNew}
                />
              );
            })}

            {/* Optimistic user message — shown instantly before API confirms.
                Hidden once the DB-fetched messages include the same text to
                avoid duplicates after page navigation. */}
            {showPendingBubble && (
              <div className="px-4 py-5">
                <div className="mx-auto max-w-3xl xl:max-w-4xl">
                  <motion.div
                    className="flex justify-end"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      type: "spring",
                      stiffness: 300,
                      damping: 30,
                      opacity: { duration: 0.2 },
                    }}
                  >
                    <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl bg-[var(--user-bubble-bg)] px-4 py-2.5 shadow-[var(--shadow-sm)] border border-[var(--border-default)]">
                      <div className="text-[15px] text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">
                        {pendingUserText}
                      </div>
                      {pendingAttachments && pendingAttachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {pendingAttachments.map((att) => (
                            <FileChip key={att.file_id} file={att} />
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                </div>
              </div>
            )}

            {/* Currently streaming message — kept visible briefly after
                generation finishes so DB messages can mount first. */}
            {(isGenerating || !!streamId || showStreamingFallback) && (
              <div className="px-4 py-5">
                <div className="mx-auto max-w-3xl xl:max-w-4xl">
                  <StreamingMessage
                    parts={streamingParts}
                    streamingText={streamingText}
                    streamingReasoning={streamingReasoning}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {/* Scroll anchor */}
        <div ref={bottomRef} className="h-px" />
      </div>

      {/* Scroll to bottom button — outside scroll container so it never affects scrollHeight */}
      <AnimatePresence>
        {!isAtBottom && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            onClick={() => { scrollToBottom(); setUnreadCount(0); }}
            aria-label="Scroll to bottom"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center h-9 w-9 rounded-full border border-[var(--border-default)] bg-[var(--surface-primary)] shadow-[var(--shadow-lg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors hover:[&_svg]:translate-y-0.5 [&_svg]:transition-transform [&_svg]:duration-150"
          >
            <ArrowDown className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--brand-primary)] text-[var(--brand-primary-text)] text-[10px] font-semibold leading-none">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
