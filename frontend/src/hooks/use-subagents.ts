"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { SubagentsResponse } from "@/types/subagent";

const EMPTY_SUBAGENTS: SubagentsResponse = {
  active: [],
  done: [],
  counts: { active: 0, done: 0, total: 0 },
};

/**
 * Parent-scoped child-agent history.
 *
 * Active work refreshes quickly enough to feel live; settled history backs off
 * to a lower-frequency refresh so sidebar/workspace summaries stay current.
 */
export function useSubagents(
  parentSessionId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.subagents(parentSessionId),
    queryFn: () =>
      api.get<SubagentsResponse>(API.SUBAGENTS(parentSessionId!)),
    enabled: (options.enabled ?? true) && !!parentSessionId,
    placeholderData: EMPTY_SUBAGENTS,
    refetchInterval: (query) =>
      (query.state.data?.counts.active ?? 0) > 0 ? 2_000 : 10_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
}
