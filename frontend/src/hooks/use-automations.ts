"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type {
  AutomationResponse,
  AutomationCreate,
  AutomationUpdate,
  TaskRunResponse,
  TemplateResponse,
} from "@/types/automation";

export function useAutomations() {
  return useQuery({
    queryKey: queryKeys.automations.all,
    queryFn: () => api.get<AutomationResponse[]>(API.AUTOMATIONS.LIST),
    staleTime: 5_000,
    // Poll faster (3s) when any task is running, otherwise every 30s
    refetchInterval: (query) => {
      const data = query.state.data as AutomationResponse[] | undefined;
      const hasRunning = data?.some((a) => a.last_run_status?.startsWith("running"));
      return hasRunning ? 3_000 : 30_000;
    },
  });
}

export function useAutomation(id: string) {
  return useQuery({
    queryKey: queryKeys.automations.detail(id),
    queryFn: () => api.get<AutomationResponse>(API.AUTOMATIONS.DETAIL(id)),
    enabled: !!id,
  });
}

export function useCreateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AutomationCreate) =>
      api.post<AutomationResponse>(API.AUTOMATIONS.CREATE, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.automations.all });
    },
  });
}

export function useUpdateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: AutomationUpdate }) =>
      api.patch<AutomationResponse>(API.AUTOMATIONS.UPDATE(id), data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.automations.all });
    },
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(API.AUTOMATIONS.DELETE(id)),
    onMutate: async (id) => {
      // Cancel in-flight refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: queryKeys.automations.all });
      const previous = queryClient.getQueryData<AutomationResponse[]>(queryKeys.automations.all);
      queryClient.setQueryData<AutomationResponse[]>(
        queryKeys.automations.all,
        (old) => old?.filter((x) => x.id !== id),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.automations.all, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.automations.all });
    },
  });
}

export function useRunAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ status: string }>(API.AUTOMATIONS.RUN(id)),
    onSuccess: () => {
      // Refresh automations list immediately to show "running" status
      queryClient.invalidateQueries({ queryKey: queryKeys.automations.all });
      // Refresh sessions sidebar so the new session appears
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    },
  });
}

export function useAutomationRuns(id: string) {
  return useQuery({
    queryKey: queryKeys.automations.runs(id),
    queryFn: () => api.get<TaskRunResponse[]>(API.AUTOMATIONS.RUNS(id)),
    enabled: !!id,
  });
}

export function useTemplates() {
  const { i18n } = useTranslation();
  return useQuery({
    queryKey: [...queryKeys.automations.templates, i18n.language],
    queryFn: () => api.get<TemplateResponse[]>(API.AUTOMATIONS.TEMPLATES),
    staleTime: Infinity, // Templates are static per language
  });
}

export function useCreateFromTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      api.post<AutomationResponse>(
        `${API.AUTOMATIONS.FROM_TEMPLATE}?template_id=${encodeURIComponent(templateId)}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.automations.all });
    },
  });
}
