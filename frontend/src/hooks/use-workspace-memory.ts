"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type {
  WorkspaceMemoryResponse,
  WorkspaceMemoryListItem,
  WorkspaceMemoryUpdate,
} from "@/types/workspace-memory";

export function useWorkspaceMemory(
  workspacePath: string | null,
  opts?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: queryKeys.workspaceMemory(workspacePath ?? ""),
    queryFn: () =>
      api.get<WorkspaceMemoryResponse>(
        `${API.WORKSPACE_MEMORY.BASE}?workspace_path=${encodeURIComponent(workspacePath!)}`,
      ),
    enabled: !!workspacePath,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: opts?.refetchInterval ?? false,
  });
}

export function useWorkspaceMemoryList() {
  return useQuery({
    queryKey: queryKeys.workspaceMemoryList,
    queryFn: () =>
      api.get<WorkspaceMemoryListItem[]>(API.WORKSPACE_MEMORY.LIST),
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useUpdateWorkspaceMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkspaceMemoryUpdate) =>
      api.put<{ status: string }>(API.WORKSPACE_MEMORY.BASE, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceMemory(variables.workspace_path),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceMemoryList,
      });
    },
  });
}

export function useDeleteWorkspaceMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspacePath: string) =>
      api.delete<{ removed: boolean }>(
        `${API.WORKSPACE_MEMORY.BASE}?workspace_path=${encodeURIComponent(workspacePath)}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceMemoryList,
      });
    },
  });
}

export function useRefreshWorkspaceMemory() {
  return useMutation({
    mutationFn: (workspacePath: string) =>
      api.post<{ status: string }>(
        `${API.WORKSPACE_MEMORY.REFRESH}?workspace_path=${encodeURIComponent(workspacePath)}`,
      ),
  });
}

export function useExportWorkspaceMemory() {
  return useMutation({
    mutationFn: (workspacePath: string) =>
      api.post<{ exported_to: string }>(
        `${API.WORKSPACE_MEMORY.EXPORT}?workspace_path=${encodeURIComponent(workspacePath)}`,
      ),
  });
}
