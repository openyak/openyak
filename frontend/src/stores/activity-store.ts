"use client";

import { create } from "zustand";
import type { ToolPart, StepStartPart, StepFinishPart } from "@/types/message";

/** A single item in the execution chain (preserves interleaving order). */
export type ChainItem =
  | { type: "reasoning"; text: string }
  | { type: "tool"; data: ToolPart };

export interface ActivityData {
  sourceKey?: string;
  reasoningTexts: string[];
  toolParts: ToolPart[];
  thinkingDuration?: number;
  stepParts: (StepStartPart | StepFinishPart)[];
  hasVisibleOutput?: boolean;
  /** Ordered chain of reasoning + tool items (preserves execution order). */
  chain: ChainItem[];
}

/** Derive wall-clock duration from tool timing (for history-loaded messages). */
export function computeDuration(data: ActivityData): number | undefined {
  if (data.thinkingDuration != null && data.thinkingDuration > 0) {
    return data.thinkingDuration;
  }
  const times: number[] = [];
  for (const tool of data.toolParts) {
    if (tool.state.time_start) times.push(new Date(tool.state.time_start).getTime());
    if (tool.state.time_end) times.push(new Date(tool.state.time_end).getTime());
  }
  if (times.length >= 2) {
    const ms = Math.max(...times) - Math.min(...times);
    return Math.round(ms / 1000);
  }
  return undefined;
}

interface ActivityStore {
  isOpen: boolean;
  activeKey: string | null;
  activeData: ActivityData | null;
  openForMessage: (key: string, data: ActivityData) => void;
  toggleForMessage: (key: string, data: ActivityData) => void;
  refreshForMessage: (key: string, data: ActivityData) => void;
  close: () => void;
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  isOpen: false,
  activeKey: null,
  activeData: null,
  openForMessage: (key, data) => {
    set({ isOpen: true, activeKey: key, activeData: data });
  },
  toggleForMessage: (key, data) => {
    const { isOpen, activeKey } = get();
    if (isOpen && activeKey === key) {
      set({ isOpen: false, activeKey: null });
    } else {
      set({ isOpen: true, activeKey: key, activeData: data });
    }
  },
  refreshForMessage: (key, data) => {
    const { isOpen, activeKey } = get();
    if (isOpen && activeKey === key) {
      set({ activeData: data });
    }
  },
  close: () => set({ isOpen: false, activeKey: null }),
}));
