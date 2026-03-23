"use client";

import { useState, useEffect } from "react";
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { SessionResponse, SessionCreate, SessionSearchResult } from "@/types/session";

const PAGE_SIZE = 50;

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useSessions() {
  return useInfiniteQuery({
    queryKey: queryKeys.sessions.all,
    queryFn: ({ pageParam = 0 }) =>
      api.get<SessionResponse[]>(API.SESSIONS.LIST(PAGE_SIZE, pageParam)),
    initialPageParam: 0,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
    refetchOnReconnect: true,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      return lastPageParam + PAGE_SIZE;
    },
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id!),
    queryFn: () => api.get<SessionResponse>(API.SESSIONS.DETAIL(id!)),
    enabled: !!id,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SessionCreate) =>
      api.post<SessionResponse>(API.SESSIONS.BASE, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(API.SESSIONS.DETAIL(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  });
}

export function useRenameSession() {
  const qc = useQueryClient();
  return useMutation<SessionResponse, unknown, { id: string; title: string }, { previous?: unknown }>({
    mutationFn: ({ id, title }) =>
      api.patch<SessionResponse>(API.SESSIONS.DETAIL(id), { title }),
    onMutate: async ({ id, title }) => {
      await qc.cancelQueries({ queryKey: queryKeys.sessions.all });
      const previous = qc.getQueryData(queryKeys.sessions.all);
      qc.setQueryData(queryKeys.sessions.all, (old: any) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((page: any) =>
            page.map((s: any) => s.id === id ? { ...s, title } : s)
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(queryKeys.sessions.all, context.previous);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  });
}

export function useSearchSessions(query: string) {
  const debouncedQuery = useDebouncedValue(query, 300);
  return useQuery({
    queryKey: queryKeys.sessions.search(debouncedQuery),
    queryFn: () =>
      api.get<SessionSearchResult[]>(API.SESSIONS.SEARCH(debouncedQuery)),
    enabled: debouncedQuery.trim().length >= 2,
  });
}
