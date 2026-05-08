"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  isRemoteMode,
  saveRemoteConfig,
  getRemoteProvider,
  saveRemoteProvider,
  type RemoteProvider,
} from "@/lib/remote-connection";
import { useSettingsStore, type ActiveProvider } from "@/stores/settings-store";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import type { ModelInfo } from "@/types/model";

/** Map remote provider key → Zustand ActiveProvider value */
const ZUSTAND_PROVIDER_MAP: Record<string, string> = {
  openrouter: "byok",
};

/** Map remote provider key → backend provider_id for model filtering */
const BACKEND_PROVIDER_MAP: Record<string, string> = {
  openrouter: "openrouter",
};

function MobileLoadingScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div className="relative w-10 h-10">
        <div className="absolute inset-0 rounded-full border-2 border-[var(--border-default)]" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--text-primary)] animate-spin" />
      </div>
      <p className="text-sm text-[var(--text-secondary)] animate-pulse">
        Connecting to OpenYak...
      </p>
    </div>
  );
}

/**
 * Ensures activeProvider + selectedModel are correct in Zustand.
 * Awaits everything — children do NOT render until this resolves.
 *
 * Provider source of truth: desktop computer's configuration,
 * fetched via GET /api/remote/provider-info.
 * Cached in localStorage as openyak_remote_provider after first fetch.
 */
async function syncProviderAndModel(): Promise<void> {
  if (!isRemoteMode()) return;

  // 1. Check if we already have a saved provider preference
  let provider: RemoteProvider | null = getRemoteProvider();

  // 2. If no saved preference, ask the desktop what providers it has
  if (!provider) {
    try {
      const info = await api.get<{ providers: string[]; primary: string | null }>(
        "/api/remote/provider-info",
      );
      if (info.primary) {
        provider = info.primary as RemoteProvider;
        saveRemoteProvider(provider);
      }
    } catch {}
  }

  if (!provider) return;

  // 3. Set activeProvider in Zustand
  const zustandValue = ZUSTAND_PROVIDER_MAP[provider] ?? "byok";
  const store = useSettingsStore.getState();
  if (store.activeProvider !== zustandValue) {
    store.setActiveProvider(zustandValue as ActiveProvider);
  }

  // 4. Ensure selectedModel belongs to the correct provider
  const backendProviderId = BACKEND_PROVIDER_MAP[provider];
  const currentModel = store.selectedModel;
  const needsModel = !currentModel;

  // Check if current model is from the wrong provider
  if (currentModel && backendProviderId) {
    try {
      const models = await api.get<ModelInfo[]>(API.MODELS);
      if (Array.isArray(models)) {
        const modelInfo = models.find((m) => m.id === currentModel);
        if (!modelInfo || modelInfo.provider_id !== backendProviderId) {
          // Wrong provider — pick a new model
          const correct = models.find((m) => m.provider_id === backendProviderId);
          if (correct) {
            useSettingsStore.getState().setSelectedModel(correct.id, correct.provider_id);
          }
        }
      }
    } catch {}
    return;
  }

  // No model selected — fetch and pick first from correct provider
  if (needsModel) {
    try {
      const models = await api.get<ModelInfo[]>(API.MODELS);
      if (Array.isArray(models)) {
        const match = models.find((m) => m.provider_id === backendProviderId);
        if (match) {
          useSettingsStore.getState().setSelectedModel(match.id, match.provider_id);
        }
      }
    } catch {}
  }
}

function MobileLayoutInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Handle ?token= from QR scan
    const tokenParam = searchParams.get("token");
    if (tokenParam) {
      saveRemoteConfig({ url: window.location.origin, token: tokenParam });
      router.replace(window.location.pathname);
    }

    // Redirect if not connected
    if (!isRemoteMode() && !window.location.pathname.includes("/m/settings")) {
      router.replace("/m/settings");
      setReady(true);
      return;
    }

    const init = async () => {
      // Wait for Zustand persist hydration
      if (useSettingsStore.persist && !useSettingsStore.persist.hasHydrated()) {
        await new Promise<void>((resolve) => {
          const unsub = useSettingsStore.persist.onFinishHydration(() => {
            unsub();
            resolve();
          });
        });
      }
      if (cancelled) return;

      // Sync provider + model from desktop config (awaits API calls)
      await syncProviderAndModel();

      if (cancelled) return;
      setReady(true);
    };

    init();
    return () => { cancelled = true; };
  }, [router, searchParams]);

  if (!ready) return <MobileLoadingScreen />;
  return <>{children}</>;
}

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col bg-[var(--surface-primary)] text-[var(--text-primary)]">
      <Suspense fallback={<MobileLoadingScreen />}>
        <MobileLayoutInner>{children}</MobileLayoutInner>
      </Suspense>
    </div>
  );
}
