"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type {
  PluginsStatusResponse,
  PluginDetail,
  SkillInfo,
  StoreSearchResponse,
} from "@/types/plugins";

export function usePluginsStatus() {
  return useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => api.get<PluginsStatusResponse>(API.PLUGINS.STATUS),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function usePluginDetail(name: string | null) {
  return useQuery({
    queryKey: queryKeys.plugins.detail(name ?? ""),
    queryFn: () => api.get<PluginDetail>(API.PLUGINS.DETAIL(name!)),
    enabled: !!name,
    staleTime: 60_000,
  });
}

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: () => api.get<SkillInfo[]>(API.SKILLS.LIST),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function usePluginToggle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enable }: { name: string; enable: boolean }) =>
      api.post<{ success: boolean; plugins: PluginsStatusResponse["plugins"] }>(
        enable ? API.PLUGINS.ENABLE(name) : API.PLUGINS.DISABLE(name),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}

export function useSkillToggle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, enable }: { name: string; enable: boolean }) =>
      api.post<{ success: boolean; skills: SkillInfo[] }>(
        enable ? API.SKILLS.ENABLE(name) : API.SKILLS.DISABLE(name),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}

// ─── Store ─────────────────────────────────────────────────────────────

export function useSkillStoreSearch(
  q: string,
  sort: "stars" | "recent" = "stars",
  page = 1,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.skillStore(q, sort, page),
    queryFn: () => {
      const params = new URLSearchParams({
        q,
        sort,
        page: String(page),
        limit: "20",
      });
      return api.get<StoreSearchResponse>(
        `${API.SKILLS.STORE_SEARCH}?${params.toString()}`,
      );
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useInstallSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ github_url, name }: { github_url: string; name?: string }) =>
      api.post<{ success: boolean; location: string; skills: SkillInfo[] }>(
        API.SKILLS.INSTALL,
        { github_url, name },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}
