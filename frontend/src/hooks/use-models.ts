"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { API, IS_DESKTOP, queryKeys } from "@/lib/constants";
import { useAuthStore } from "@/stores/auth-store";
import type { ModelInfo } from "@/types/model";

const MODEL_LOAD_TIMEOUT_MS = 60_000;

let desktopModelSyncPromise: Promise<void> | null = null;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function ensureDesktopOpenYakAccountSynced(): Promise<void> {
  if (!IS_DESKTOP) return;

  const auth = useAuthStore.getState();
  if (!auth.isConnected || !auth.proxyUrl || !auth.accessToken) return;

  if (!desktopModelSyncPromise) {
    desktopModelSyncPromise = (async () => {
      try {
        const status = await api.get<{
          is_connected: boolean;
          proxy_url: string;
          has_refresh_token?: boolean;
        }>(API.CONFIG.OPENYAK_ACCOUNT);
        const refreshTokenSynced = !auth.refreshToken || status.has_refresh_token === true;
        if (status.is_connected && status.proxy_url === auth.proxyUrl && refreshTokenSynced) return;
      } catch {
        // Fall through and force a re-sync.
      }

      await api.post(API.CONFIG.OPENYAK_ACCOUNT, {
        proxy_url: auth.proxyUrl,
        token: auth.accessToken,
        ...(auth.refreshToken ? { refresh_token: auth.refreshToken } : {}),
      }, {
        timeoutMs: MODEL_LOAD_TIMEOUT_MS,
      });
    })().finally(() => {
      desktopModelSyncPromise = null;
    });
  }

  await desktopModelSyncPromise;
}

export function useModels() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: async () => {
      return withTimeout(
        (async () => {
          await ensureDesktopOpenYakAccountSynced();
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
