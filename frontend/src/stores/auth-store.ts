"use client";

import { useState, useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface OpenYakUser {
  id: string;
  email: string;
  billing_mode: "free" | "credits";
  credit_balance: number;
  daily_free_tokens_used: number;
  daily_free_token_limit: number;
}

interface AuthStore {
  /** Proxy URL (e.g. "https://api.openyak.app") */
  proxyUrl: string;
  /** JWT access token for the OpenYak proxy */
  accessToken: string;
  /** JWT refresh token */
  refreshToken: string;
  /** User profile from proxy /auth/me */
  user: OpenYakUser | null;
  /** Whether account is connected */
  isConnected: boolean;

  setAuth: (params: {
    proxyUrl: string;
    accessToken: string;
    refreshToken: string;
    user: OpenYakUser;
  }) => void;
  updateUser: (user: OpenYakUser) => void;
  updateBalance: (credits: number) => void;
  updateQuota: (tokensUsed: number) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      proxyUrl: "",
      accessToken: "",
      refreshToken: "",
      user: null,
      isConnected: false,

      setAuth: ({ proxyUrl, accessToken, refreshToken, user }) =>
        set({ proxyUrl, accessToken, refreshToken, user, isConnected: true }),

      updateUser: (user) => set({ user }),

      updateBalance: (credits) =>
        set((s) => ({
          user: s.user ? { ...s.user, credit_balance: credits } : null,
        })),

      updateQuota: (tokensUsed) =>
        set((s) => ({
          user: s.user
            ? { ...s.user, daily_free_tokens_used: tokensUsed }
            : null,
        })),

      logout: () =>
        set({
          proxyUrl: "",
          accessToken: "",
          refreshToken: "",
          user: null,
          isConnected: false,
        }),
    }),
    {
      name: "openyak-auth",
    },
  ),
);

// Hydration tracking
const useAuthHasHydrated = () => {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!useAuthStore.persist) {
      setHydrated(true);
      return;
    }
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    return () => {
      unsub();
    };
  }, []);
  return hydrated;
};

export { useAuthHasHydrated };
