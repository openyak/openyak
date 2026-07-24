"use client";

import { create } from "zustand";
import type { EvidenceOrigin } from "@/types/subagent";

export interface WorkspaceTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  type: "instructions" | "generated" | "uploaded" | "referenced";
  /** Direct producer metadata from session file discovery, when available. */
  tool?: string;
  /** Every parent/child producer retained after path deduplication. */
  origins?: EvidenceOrigin[];
}

export interface WorkspaceSessionState {
  isOpen: boolean;
  /** Per-section collapsed state (false / missing = expanded). */
  collapsedSections: Record<string, boolean>;
  todos: WorkspaceTodo[];
  workspaceFiles: WorkspaceFile[];
  scratchpadContent: string;
  /** This Session's Workspace directory. */
  activeWorkspacePath: string | null;
}

interface WorkspaceStore extends WorkspaceSessionState {
  /** Session currently projected into the Workspace panel. */
  activeSessionId: string | null;
  /** Durable in-memory Workspace UI state, isolated by Session. */
  sessionStates: Record<string, WorkspaceSessionState>;

  toggle: () => void;
  open: () => void;
  close: () => void;
  activateSession: (sessionId: string) => void;
  deactivateSession: (sessionId: string) => void;
  getSessionState: (sessionId: string) => WorkspaceSessionState;
  toggleSection: (section: string) => void;
  expandSection: (section: string) => void;
  collapseSection: (section: string) => void;
  setTodos: (todos: WorkspaceTodo[]) => void;
  addWorkspaceFile: (file: WorkspaceFile) => void;
  setWorkspaceFiles: (files: WorkspaceFile[]) => void;
  setScratchpadContent: (content: string) => void;
  setActiveWorkspacePath: (path: string | null) => void;
  setTodosForSession: (sessionId: string, todos: WorkspaceTodo[]) => void;
  setWorkspaceFilesForSession: (sessionId: string, files: WorkspaceFile[]) => void;
  setScratchpadContentForSession: (sessionId: string, content: string) => void;
  setActiveWorkspacePathForSession: (sessionId: string, path: string | null) => void;
  openForSession: (sessionId: string) => void;
  expandSectionForSession: (sessionId: string, section: string) => void;
  collapseSectionForSession: (sessionId: string, section: string) => void;
  resetForSession: () => void;
  resetAllSessions: () => void;
}

function createCollapsedSections(): Record<string, boolean> {
  return {
    progress: true,
    files: false,
    context: true,
  };
}

function createWorkspaceSessionState(): WorkspaceSessionState {
  return {
    isOpen: false,
    collapsedSections: createCollapsedSections(),
    todos: [],
    workspaceFiles: [],
    scratchpadContent: "",
    activeWorkspacePath: null,
  };
}

function selectProjectedState(state: WorkspaceSessionState): WorkspaceSessionState {
  return {
    isOpen: state.isOpen,
    collapsedSections: state.collapsedSections,
    todos: state.todos,
    workspaceFiles: state.workspaceFiles,
    scratchpadContent: state.scratchpadContent,
    activeWorkspacePath: state.activeWorkspacePath,
  };
}

function updateSessionState(
  state: WorkspaceStore,
  sessionId: string,
  patch: Partial<WorkspaceSessionState>,
): Partial<WorkspaceStore> {
  const current =
    state.activeSessionId === sessionId
      ? selectProjectedState(state)
      : state.sessionStates[sessionId] ?? createWorkspaceSessionState();
  const next = { ...current, ...patch };

  return {
    sessionStates: {
      ...state.sessionStates,
      [sessionId]: next,
    },
    ...(state.activeSessionId === sessionId ? selectProjectedState(next) : {}),
  };
}

function updateActiveSessionState(
  state: WorkspaceStore,
  patch: Partial<WorkspaceSessionState>,
): Partial<WorkspaceStore> {
  if (!state.activeSessionId) return patch;
  return updateSessionState(state, state.activeSessionId, patch);
}

function normalizeWorkspacePath(path: string | null): string | null {
  return path && path !== "." ? path : null;
}

const initialWorkspaceState = createWorkspaceSessionState();

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  ...initialWorkspaceState,
  activeSessionId: null,
  sessionStates: {},

  activateSession: (sessionId) =>
    set((state) => {
      if (state.activeSessionId === sessionId) return state;

      const sessionStates = { ...state.sessionStates };
      if (state.activeSessionId) {
        sessionStates[state.activeSessionId] = selectProjectedState(state);
      }
      const next = sessionStates[sessionId] ?? createWorkspaceSessionState();
      sessionStates[sessionId] = next;
      return {
        activeSessionId: sessionId,
        sessionStates,
        ...selectProjectedState(next),
      };
    }),

  deactivateSession: (sessionId) =>
    set((state) => {
      if (state.activeSessionId !== sessionId) return state;
      return {
        activeSessionId: null,
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: selectProjectedState(state),
        },
        ...createWorkspaceSessionState(),
      };
    }),

  getSessionState: (sessionId) => {
    const state = get();
    return state.activeSessionId === sessionId
      ? selectProjectedState(state)
      : state.sessionStates[sessionId] ?? createWorkspaceSessionState();
  },

  toggle: () => {
    const willOpen = !get().isOpen;
    set((state) => updateActiveSessionState(state, { isOpen: willOpen }));
  },
  open: () => {
    set((state) => updateActiveSessionState(state, { isOpen: true }));
  },
  close: () => set((state) => updateActiveSessionState(state, { isOpen: false })),
  openForSession: (sessionId) => {
    set((state) => updateSessionState(state, sessionId, { isOpen: true }));
  },

  toggleSection: (section) =>
    set((state) =>
      updateActiveSessionState(state, {
        collapsedSections: {
          ...state.collapsedSections,
          [section]: !state.collapsedSections[section],
        },
      }),
    ),

  expandSection: (section) =>
    set((state) =>
      updateActiveSessionState(state, {
        collapsedSections: {
          ...state.collapsedSections,
          [section]: false,
        },
      }),
    ),

  collapseSection: (section) =>
    set((state) =>
      updateActiveSessionState(state, {
        collapsedSections: {
          ...state.collapsedSections,
          [section]: true,
        },
      }),
    ),

  expandSectionForSession: (sessionId, section) =>
    set((state) => {
      const current = state.activeSessionId === sessionId
        ? state
        : state.sessionStates[sessionId] ?? createWorkspaceSessionState();
      return updateSessionState(state, sessionId, {
        collapsedSections: {
          ...current.collapsedSections,
          [section]: false,
        },
      });
    }),

  collapseSectionForSession: (sessionId, section) =>
    set((state) => {
      const current = state.activeSessionId === sessionId
        ? state
        : state.sessionStates[sessionId] ?? createWorkspaceSessionState();
      return updateSessionState(state, sessionId, {
        collapsedSections: {
          ...current.collapsedSections,
          [section]: true,
        },
      });
    }),

  setTodos: (todos) =>
    set((state) =>
      updateActiveSessionState(state, {
        todos,
        ...(todos.length > 0 ? { isOpen: true } : {}),
      }),
    ),

  setTodosForSession: (sessionId, todos) =>
    set((state) =>
      updateSessionState(state, sessionId, {
        todos,
        ...(todos.length > 0 ? { isOpen: true } : {}),
      }),
    ),

  addWorkspaceFile: (file) => {
    const { workspaceFiles } = get();
    if (workspaceFiles.some((f) => f.path === file.path)) return;
    set((state) =>
      updateActiveSessionState(state, {
        workspaceFiles: [...state.workspaceFiles, file],
      }),
    );
  },

  setWorkspaceFiles: (files) =>
    set((state) => updateActiveSessionState(state, { workspaceFiles: files })),
  setWorkspaceFilesForSession: (sessionId, files) =>
    set((state) => updateSessionState(state, sessionId, { workspaceFiles: files })),
  setScratchpadContent: (content) =>
    set((state) => updateActiveSessionState(state, { scratchpadContent: content })),
  setScratchpadContentForSession: (sessionId, content) =>
    set((state) => updateSessionState(state, sessionId, { scratchpadContent: content })),
  setActiveWorkspacePath: (path) =>
    set((state) =>
      updateActiveSessionState(state, {
        activeWorkspacePath: normalizeWorkspacePath(path),
      }),
    ),
  setActiveWorkspacePathForSession: (sessionId, path) =>
    set((state) =>
      updateSessionState(state, sessionId, {
        activeWorkspacePath: normalizeWorkspacePath(path),
      }),
    ),

  resetForSession: () =>
    set((state) => updateActiveSessionState(state, createWorkspaceSessionState())),

  resetAllSessions: () =>
    set({
      activeSessionId: null,
      sessionStates: {},
      ...createWorkspaceSessionState(),
    }),
}));
