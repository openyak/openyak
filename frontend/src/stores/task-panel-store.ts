"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TaskPanelSection = "plan" | "artifact" | "activity" | "workspace";

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 480;

function maxWidth(): number {
  if (typeof window === "undefined") return 720;
  return Math.round(window.innerWidth * 0.6);
}

interface TaskPanelStore {
  /** Panel width in pixels (desktop only; plan review may force it wider). */
  width: number;
  /** Sections the user has manually collapsed. */
  collapsed: Partial<Record<TaskPanelSection, boolean>>;
  setWidth: (width: number) => void;
  toggleSection: (section: TaskPanelSection) => void;
  expandSection: (section: TaskPanelSection) => void;
}

/**
 * Layout state for the unified right-hand task panel. What each section
 * SHOWS still lives in its own store (plan-review / artifact / activity /
 * workspace) — this store only owns panel geometry and collapse state.
 */
export const useTaskPanelStore = create<TaskPanelStore>()(
  persist(
    (set) => ({
      width: DEFAULT_WIDTH,
      collapsed: {},
      setWidth: (width) =>
        set({ width: Math.min(Math.max(width, MIN_WIDTH), maxWidth()) }),
      toggleSection: (section) =>
        set((s) => ({
          collapsed: { ...s.collapsed, [section]: !s.collapsed[section] },
        })),
      expandSection: (section) =>
        set((s) =>
          s.collapsed[section]
            ? { collapsed: { ...s.collapsed, [section]: false } }
            : s,
        ),
    }),
    { name: "openyak-task-panel", version: 1 },
  ),
);
