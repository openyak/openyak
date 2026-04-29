"use client";

import { useMemo } from "react";
import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { PaginatedMessages } from "@/types/message";

const PAGE_SIZE = 50;

/**
 * Hook to fetch messages with reverse infinite scroll.
 *
 * Initial load fetches the latest page (offset=-1).
 * `fetchPreviousPage()` loads older messages.
 * Pages are stored oldest-first: pages[0] = oldest loaded, pages[last] = newest.
 */
export function useMessages(sessionId: string | undefined) {
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
    refetchOnWindowFocus: true,
    staleTime: 5_000, // Refetch if data is older than 5s (catches remote-generated sessions)
    // Poll every 10s to catch channel messages (WhatsApp, Discord, etc.)
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  // Flatten pages into a single chronological array. Reverse infinite scroll
  // can briefly overlap the latest page with older pages after refetches.
  const messages = useMemo(() => {
    const byId = new Map<string, PaginatedMessages["messages"][number]>();
    const order: string[] = [];
    for (const message of query.data?.pages.flatMap((p) => p.messages) ?? []) {
      if (!byId.has(message.id)) {
        order.push(message.id);
      }
      // Keep the freshest copy if an overlapped page contains the same id.
      byId.set(message.id, message);
    }
    return order.map((id) => byId.get(id)!);
  }, [query.data]);

  const total = query.data?.pages[0]?.total ?? 0;

  return {
    ...query,
    messages,
    total,
  };
}
