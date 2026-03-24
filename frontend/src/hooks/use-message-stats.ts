"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { PaginatedMessages, MessageResponse, AssistantMessageInfo } from "@/types/message";

const PAGE_SIZE = 50;

function extractStepSnapshot(msg: MessageResponse): Record<string, number> | null {
  let latest: Record<string, number> | null = null;
  for (const part of msg.parts) {
    if (part.data.type === "step-finish") {
      latest = part.data.tokens || null;
    }
  }
  return latest;
}

export interface MessageStats {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  percentage: number;
  hasCompaction: boolean;
}

const DEFAULT_CONTEXT_LIMIT = 200_000;

function computeStats(messages: MessageResponse[], maxContext?: number): MessageStats {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let hasCompaction = false;

  for (const msg of messages) {
    // Check for compaction events
    const compactionParts = msg.parts.filter((p) => p.data.type === "compaction");
    if (compactionParts.length > 0) {
      hasCompaction = true;
    }

    // Use the latest assistant usage snapshot for context indicator.
    // This tracks current context occupancy more accurately than summing history.
    if ((msg.data as AssistantMessageInfo).role !== "assistant") {
      continue;
    }

    const info = msg.data as AssistantMessageInfo;
    const snapshot = extractStepSnapshot(msg) || info.tokens;
    if (!snapshot) {
      continue;
    }

    const input = snapshot.input || 0;
    const output = (snapshot.output || 0) + (snapshot.reasoning || 0);
    const cacheRead = snapshot.cache_read || 0;
    const cacheWrite = snapshot.cache_write || 0;

    const snapshotTotal = input + output + cacheRead;
    if (snapshotTotal > 0) {
      totalInputTokens = input;
      totalOutputTokens = output;
      totalCacheRead = cacheRead;
      totalCacheWrite = cacheWrite;
    }
  }

  // Context occupancy = prompt tokens only (input + cacheRead).
  // Output tokens are generated outside the context window.
  const totalTokens = totalInputTokens + totalCacheRead;
  const contextLimit = maxContext && maxContext > 0 ? maxContext : DEFAULT_CONTEXT_LIMIT;
  const percentage = Math.min((totalTokens / contextLimit) * 100, 100);

  return {
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    totalCacheWrite,
    percentage,
    hasCompaction,
  };
}

/**
 * Hook to get message statistics for a session.
 *
 * Shares the same infinite query cache as useMessages — no extra network request.
 * Derives stats from the loaded pages using useMemo.
 */
export function useMessageStats(sessionId: string | undefined, maxContext?: number) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.messages.list(sessionId!),
    queryFn: ({ pageParam }: { pageParam: number }) =>
      api.get<PaginatedMessages>(API.MESSAGES.LIST(sessionId!, PAGE_SIZE, pageParam)),
    initialPageParam: -1 as number,
    getPreviousPageParam: (firstPage: PaginatedMessages) => {
      if (firstPage.offset <= 0) return undefined;
      return Math.max(0, firstPage.offset - PAGE_SIZE);
    },
    getNextPageParam: (): undefined => undefined,
    enabled: !!sessionId,
    staleTime: 60_000,
  });

  const stats = useMemo(() => {
    if (!query.data) return undefined;
    return computeStats(query.data.pages.flatMap((p) => p.messages), maxContext);
  }, [query.data, maxContext]);

  return { ...query, data: stats };
}
