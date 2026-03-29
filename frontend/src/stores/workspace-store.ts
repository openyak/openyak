"use client";

import { create } from "zustand";

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

interface WorkspaceStore {
  isOpen: boolean;
  /** Per-section collapsed state (false / missing = expanded). */
  collapsedSections: Record<string, boolean>;
  todos: WorkspaceTodo[];
  workspaceFiles: WorkspaceFile[];
  scratchpadContent: string;
  /** Current session's workspace directory (set by ChatView on session load). */
  activeWorkspacePath: string | null;

  toggle: () => void;
  open: () => void;
  close: () => void;
  toggleSection: (section: string) => void;
  expandSection: (section: string) => void;
  setTodos: (todos: WorkspaceTodo[]) => void;
  addWorkspaceFile: (file: WorkspaceFile) => void;
  setWorkspaceFiles: (files: WorkspaceFile[]) => void;
  setScratchpadContent: (content: string) => void;
  setActiveWorkspacePath: (path: string | null) => void;
  resetForSession: () => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  isOpen: false,
  collapsedSections: {},
  todos: [],
  workspaceFiles: [],
  scratchpadContent: "",
  activeWorkspacePath: null,

  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  open: () => set({ isOpen: true }),
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

  setTodos: (todos) => set({ todos }),

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
      workspaceFiles: [],
      scratchpadContent: "",
      collapsedSections: {},
      activeWorkspacePath: null,
    }),
}));
