"use client";

import { create } from "zustand";
import type { Artifact } from "@/types/artifact";
import { ARTIFACT_PANEL_WIDTH } from "@/lib/constants";

interface ArtifactStore {
  /** Whether the artifact panel is open. */
  isOpen: boolean;
  /** The currently displayed artifact. */
  activeArtifact: Artifact | null;
  /** All artifacts in the current session (for prev/next navigation). */
  artifacts: Artifact[];
  /** Index of activeArtifact within the artifacts array. */
  activeIndex: number;
  /** Current panel width in pixels (user-resizable). */
  panelWidth: number;
  /** Version history per identifier. Key = identifier, Value = Artifact[] (chronological). */
  versionHistory: Map<string, Artifact[]>;
  /** Active version index within the current artifact's version history. -1 if N/A. */
  activeVersionIndex: number;

  /** Open the panel with a specific artifact. Closes ActivityPanel. */
  openArtifact: (artifact: Artifact) => void;
  /** Close the panel. */
  close: () => void;
  /** Navigate to the next artifact. */
  goNext: () => void;
  /** Navigate to the previous artifact. */
  goPrev: () => void;
  /** Navigate to a specific version of the current artifact. */
  goToVersion: (versionIndex: number) => void;
  /** Clear all artifacts (e.g. on session change). */
  clearAll: () => void;
  /** Set the panel width (for resize). */
  setWidth: (width: number) => void;
  /** Pending fix request message (to be picked up by ChatForm). */
  fixRequest: string | null;
  /** Request a fix by sending error context to the chat input. */
  requestFix: (message: string) => void;
  /** Clear the fix request (after ChatForm consumes it). */
  clearFixRequest: () => void;
}

export const useArtifactStore = create<ArtifactStore>((set, get) => ({
  isOpen: false,
  activeArtifact: null,
  artifacts: [],
  activeIndex: -1,
  panelWidth: typeof window !== "undefined" ? Math.round(window.innerWidth / 2) : ARTIFACT_PANEL_WIDTH,
  versionHistory: new Map(),
  activeVersionIndex: -1,
  fixRequest: null,

  openArtifact: (artifact) => {
    // Close the activity panel (mutual exclusion)
    // Close the plan review panel (mutual exclusion)

    // Auto-size panel: 40% when sidebar is open, 50% when collapsed
    if (typeof window !== "undefined" && !get().isOpen) {
      try {
        const { useSidebarStore } = require("@/stores/sidebar-store");
        const state = useSidebarStore.getState();
        const sidebarOpen = !state.isCollapsed;
        const availableWidth = window.innerWidth - (sidebarOpen ? state.width : 0);
        const targetRatio = sidebarOpen ? 0.4 : 0.5;
        const newWidth = Math.max(360, Math.round(availableWidth * targetRatio));
        set({ panelWidth: newWidth });
      } catch {
        // Sidebar store may not be available
      }
    }

    const state = get();
    const existing = state.artifacts.findIndex(
      (a) => a.id === artifact.id || (a.identifier && a.identifier === artifact.identifier),
    );

    const newHistory = new Map(state.versionHistory);

    if (existing >= 0) {
      const existingArtifact = state.artifacts[existing];

      if (artifact.identifier) {
        const versions = newHistory.get(artifact.identifier) || [];

        // Seed history with the original version on first update
        if (versions.length === 0) {
          versions.push(existingArtifact);
        }

        // Only add if genuinely new content (avoid duplicates on re-click)
        const lastVersion = versions[versions.length - 1];
        if (lastVersion.id !== artifact.id) {
          versions.push(artifact);
        }

        newHistory.set(artifact.identifier, versions);
      }

      // Replace in flat list with latest version
      const updated = [...state.artifacts];
      updated[existing] = artifact;

      set({
        isOpen: true,
        activeArtifact: artifact,
        artifacts: updated,
        activeIndex: existing,
        versionHistory: newHistory,
        activeVersionIndex: artifact.identifier
          ? (newHistory.get(artifact.identifier)?.length ?? 1) - 1
          : -1,
      });
    } else {
      // New artifact — seed version history if it has an identifier
      if (artifact.identifier) {
        newHistory.set(artifact.identifier, [artifact]);
      }

      const updated = [...state.artifacts, artifact];
      set({
        isOpen: true,
        activeArtifact: artifact,
        artifacts: updated,
        activeIndex: updated.length - 1,
        versionHistory: newHistory,
        activeVersionIndex: artifact.identifier ? 0 : -1,
      });
    }
  },

  close: () => set({ isOpen: false }),

  goNext: () => {
    const { artifacts, activeIndex, versionHistory } = get();
    if (activeIndex < artifacts.length - 1) {
      const next = activeIndex + 1;
      const nextArtifact = artifacts[next];
      const versions = nextArtifact.identifier
        ? versionHistory.get(nextArtifact.identifier)
        : undefined;
      set({
        activeIndex: next,
        activeArtifact: nextArtifact,
        activeVersionIndex: versions ? versions.length - 1 : -1,
      });
    }
  },

  goPrev: () => {
    const { artifacts, activeIndex, versionHistory } = get();
    if (activeIndex > 0) {
      const prev = activeIndex - 1;
      const prevArtifact = artifacts[prev];
      const versions = prevArtifact.identifier
        ? versionHistory.get(prevArtifact.identifier)
        : undefined;
      set({
        activeIndex: prev,
        activeArtifact: prevArtifact,
        activeVersionIndex: versions ? versions.length - 1 : -1,
      });
    }
  },

  goToVersion: (versionIndex) => {
    const { activeArtifact, versionHistory } = get();
    if (!activeArtifact?.identifier) return;

    const versions = versionHistory.get(activeArtifact.identifier);
    if (!versions || versionIndex < 0 || versionIndex >= versions.length) return;

    set({
      activeArtifact: versions[versionIndex],
      activeVersionIndex: versionIndex,
    });
  },

  clearAll: () =>
    set({
      isOpen: false,
      activeArtifact: null,
      artifacts: [],
      activeIndex: -1,
      versionHistory: new Map(),
      activeVersionIndex: -1,
    }),

  setWidth: (width) => set({ panelWidth: Math.max(360, Math.min(Math.round(window.innerWidth * 0.75), width)) }),

  requestFix: (message) => set({ fixRequest: message }),
  clearFixRequest: () => set({ fixRequest: null }),
}));
