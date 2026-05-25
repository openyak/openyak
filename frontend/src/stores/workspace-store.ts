"use client";

import { create } from "zustand";

/** Close overlay panels (activity/artifact/plan-review) when workspace opens. */
function closeOverlayPanels() {
  try {
    const { useActivityStore } = require("@/stores/activity-store");
    useActivityStore.getState().close();
  } catch {
    // store may not be available during SSR
  }
  try {
    const { useArtifactStore } = require("@/stores/artifact-store");
    useArtifactStore.getState().close();
  } catch {
    // store may not be available during SSR
  }
  try {
    const { usePlanReviewStore } = require("@/stores/plan-review-store");
    usePlanReviewStore.getState().close();
  } catch {
    // store may not be available during SSR
  }
}

export interface WorkspaceTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  type: "instructions" | "generated" | "uploaded" | "referenced";
}

export interface WorkspaceAgentTask {
  task_id: string;
  session_id: string;
  title: string;
  agent: string;
  model?: string | null;
  provider_id?: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  error?: string | null;
}

export interface WorkspaceTaskBatch {
  batch_id: string;
  mode: "sequential" | "parallel";
  tasks: WorkspaceAgentTask[];
}

interface WorkspaceStore {
  isOpen: boolean;
  /** Per-section collapsed state (false / missing = expanded). */
  collapsedSections: Record<string, boolean>;
  todos: WorkspaceTodo[];
  taskBatch: WorkspaceTaskBatch | null;
  workspaceFiles: WorkspaceFile[];
  scratchpadContent: string;
  /** Current session's workspace directory (set by ChatView on session load). */
  activeWorkspacePath: string | null;

  toggle: () => void;
  open: () => void;
  close: () => void;
  toggleSection: (section: string) => void;
  expandSection: (section: string) => void;
  collapseSection: (section: string) => void;
  setTodos: (todos: WorkspaceTodo[]) => void;
  setTaskBatch: (batch: WorkspaceTaskBatch | null) => void;
  addWorkspaceFile: (file: WorkspaceFile) => void;
  setWorkspaceFiles: (files: WorkspaceFile[]) => void;
  setScratchpadContent: (content: string) => void;
  setActiveWorkspacePath: (path: string | null) => void;
  resetForSession: () => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  isOpen: false,
  collapsedSections: {
    progress: true,
    files: true,
    context: true,
  },
  todos: [],
  taskBatch: null,
  workspaceFiles: [],
  scratchpadContent: "",
  activeWorkspacePath: null,

  toggle: () => {
    const willOpen = !get().isOpen;
    if (willOpen) closeOverlayPanels();
    set({ isOpen: willOpen });
  },
  open: () => {
    closeOverlayPanels();
    set({ isOpen: true });
  },
  close: () => set({ isOpen: false }),

  toggleSection: (section) =>
    set((s) => ({
      collapsedSections: {
        ...s.collapsedSections,
        [section]: !s.collapsedSections[section],
      },
    })),

  expandSection: (section) =>
    set((s) => ({
      collapsedSections: {
        ...s.collapsedSections,
        [section]: false,
      },
    })),

  collapseSection: (section) =>
    set((s) => ({
      collapsedSections: {
        ...s.collapsedSections,
        [section]: true,
      },
    })),

  setTodos: (todos) => set({ todos, ...(todos.length > 0 ? { isOpen: true } : {}) }),
  setTaskBatch: (taskBatch) => set({ taskBatch, ...(taskBatch ? { isOpen: true } : {}) }),

  addWorkspaceFile: (file) => {
    const { workspaceFiles } = get();
    if (workspaceFiles.some((f) => f.path === file.path)) return;
    set({ workspaceFiles: [...workspaceFiles, file] });
  },

  setWorkspaceFiles: (files) => set({ workspaceFiles: files }),
  setScratchpadContent: (content) => set({ scratchpadContent: content }),
  setActiveWorkspacePath: (path) => set({ activeWorkspacePath: path && path !== "." ? path : null }),

  resetForSession: () =>
    set({
      todos: [],
      taskBatch: null,
      workspaceFiles: [],
      scratchpadContent: "",
      collapsedSections: {
        progress: true,
        files: true,
        context: true,
      },
      activeWorkspacePath: null,
      isOpen: false,
    }),
}));
