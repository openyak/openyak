"use client";

import { create } from "zustand";

interface BrowserWorkspaceStore {
  isOpen: boolean;
  activeTabId: string | null;
  open: (tabId?: string | null) => void;
  close: () => void;
  selectTab: (tabId: string) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  isOpen: false,
  activeTabId: null as string | null,
};

export const useBrowserWorkspaceStore = create<BrowserWorkspaceStore>((set) => ({
  ...INITIAL_STATE,
  open: (tabId) =>
    set((state) => ({
      isOpen: true,
      activeTabId: tabId ?? state.activeTabId,
    })),
  close: () => set({ isOpen: false }),
  selectTab: (tabId) => set({ activeTabId: tabId }),
  reset: () => set(INITIAL_STATE),
}));
