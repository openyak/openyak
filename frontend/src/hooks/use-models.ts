"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, queryKeys } from "@/lib/constants";
import type { ModelInfo } from "@/types/model";

const MODEL_LOAD_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function useModels() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: async () => {
      return withTimeout(
        (async () => {
          return api.get<ModelInfo[]>(API.MODELS, {
            timeoutMs: MODEL_LOAD_TIMEOUT_MS,
          });
        })(),
        MODEL_LOAD_TIMEOUT_MS,
        "Timed out loading models. Check your provider connection, firewall, or VPN settings.",
      );
    },
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
