"use client";

import { create } from "zustand";
import type { PlanReviewRequest } from "@/types/streaming";

interface PlanReviewStore {
  isOpen: boolean;
  /** Plan data stored here so it survives finishGeneration clearing chat store */
  planData: PlanReviewRequest | null;
  /** Panel width in pixels — defaults to half the viewport */
  panelWidth: number;

  openReview: (data: PlanReviewRequest) => void;
  close: () => void;
  updateWidth: () => void;
}

function getHalfViewport(): number {
  if (typeof window === "undefined") return 520;
  return Math.max(Math.floor(window.innerWidth / 2), 480);
}

export const usePlanReviewStore = create<PlanReviewStore>((set) => ({
  isOpen: false,
  planData: null,
  panelWidth: getHalfViewport(),

  openReview: (data) => {
    set({ isOpen: true, planData: data, panelWidth: getHalfViewport() });
  },

  close: () => set({ isOpen: false, planData: null }),

  updateWidth: () => set({ panelWidth: getHalfViewport() }),
}));
