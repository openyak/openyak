"use client";

import { create } from "zustand";

interface ComputerWorkspaceStore {
  isOpen: boolean;
  applicationId: string | null;
  open: (applicationId?: string | null) => void;
  close: () => void;
  selectApplication: (applicationId: string) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  isOpen: false,
  applicationId: null as string | null,
};

export const useComputerWorkspaceStore = create<ComputerWorkspaceStore>((set) => ({
  ...INITIAL_STATE,
  open: (applicationId) =>
    set((state) => ({
      isOpen: true,
      applicationId: applicationId ?? state.applicationId,
    })),
  close: () => set({ isOpen: false }),
  selectApplication: (applicationId) => set({ applicationId }),
  reset: () => set(INITIAL_STATE),
}));
