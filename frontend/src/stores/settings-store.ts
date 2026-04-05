"use client";

import { useState, useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface PermissionPresets {
  fileChanges: boolean;
  runCommands: boolean;
}

/** Saved permission rules for specific tools */
export interface SavedPermissionRule {
  tool: string;
  allow: boolean;
  timestamp: number;
}

export type ActiveProvider = "openyak" | "byok" | "chatgpt" | "ollama" | "local" | "custom" | null;

/**
 * Unified work mode — maps to agent + permission presets:
 *   plan → agent=plan (read-only)
 *   ask  → agent=build, auto-approve off
 *   auto → agent=build, auto-approve on
 */
export type WorkMode = "plan" | "ask" | "auto";

interface SettingsStore {
  /** Whether the user has completed the first-run onboarding flow */
  hasCompletedOnboarding: boolean;
  /** Selected model ID (e.g. "claude-sonnet-4-20250514") */
  selectedModel: string | null;
  /** Selected provider ID for the model (e.g. "anthropic") — determines which API key is used */
  selectedProviderId: string | null;
  /** Selected agent name — derived from workMode */
  selectedAgent: string;
  /** Safe mode: read-only analysis, no file changes or commands */
  safeMode: boolean;
  /** Unified work mode */
  workMode: WorkMode;
  /** Whether reasoning/thinking mode is enabled */
  reasoningEnabled: boolean;
  /** Permission presets — auto-allow tool categories */
  permissionPresets: PermissionPresets;
  /** Saved permission rules for specific tools */
  savedPermissions: SavedPermissionRule[];
  /** Workspace directory restriction — agent can only access files inside this dir */
  workspaceDirectory: string | null;
  /** Whether the user has seen the first-use feature hints */
  hasSeenHints: boolean;
  /** UI language code (e.g. "en", "zh") */
  language: string;
  /** Active provider whose models are shown in selectors */
  activeProvider: ActiveProvider;
  /** Set model and its provider */
  setSelectedModel: (model: string | null, providerId?: string | null) => void;
  /** Set agent (for backward compatibility) */
  setSelectedAgent: (agent: string) => void;
  /** Toggle safe mode on/off */
  setSafeMode: (enabled: boolean) => void;
  /** Set unified work mode (plan / ask / auto) */
  setWorkMode: (mode: WorkMode) => void;
  /** Set reasoning mode */
  setReasoningEnabled: (enabled: boolean) => void;
  /** Toggle a single permission preset */
  togglePermissionPreset: (key: keyof PermissionPresets) => void;
  /** Save a permission rule for a tool */
  savePermissionRule: (tool: string, allow: boolean) => void;
  /** Get saved permission for a tool (if any) */
  getSavedPermission: (tool: string) => boolean | null;
  /** Clear a saved permission rule */
  clearPermissionRule: (tool: string) => void;
  /** Clear all saved permission rules */
  clearAllPermissionRules: () => void;
  /** Set workspace directory (null = unrestricted) */
  setWorkspaceDirectory: (dir: string | null) => void;
  /** Mark onboarding as complete */
  completeOnboarding: () => void;
  /** Mark feature hints as seen */
  setHasSeenHints: (seen: boolean) => void;
  /** Set UI language */
  setLanguage: (lang: string) => void;
  /** Set active provider */
  setActiveProvider: (provider: ActiveProvider) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      hasCompletedOnboarding: false,
      selectedModel: null,
      selectedProviderId: null,
      selectedAgent: "build",
      safeMode: false,
      workMode: "auto" as WorkMode,
      reasoningEnabled: true,
      permissionPresets: { fileChanges: true, runCommands: true },
      savedPermissions: [],
      workspaceDirectory: null,
      hasSeenHints: false,
      language: "auto",
      activeProvider: null,
      setSelectedModel: (model, providerId) => set({ selectedModel: model, selectedProviderId: providerId ?? null }),
      setSelectedAgent: (agent) => {
        const isPlan = agent === "plan";
        const currentPresets = get().permissionPresets;
        const mode: WorkMode = isPlan ? "plan" : (currentPresets.fileChanges ? "auto" : "ask");
        set({ selectedAgent: agent, safeMode: isPlan, workMode: mode });
      },
      setSafeMode: (enabled) => {
        const currentPresets = get().permissionPresets;
        const mode: WorkMode = enabled ? "plan" : (currentPresets.fileChanges ? "auto" : "ask");
        set({ safeMode: enabled, selectedAgent: enabled ? "plan" : "build", workMode: mode });
      },
      setWorkMode: (mode) => {
        switch (mode) {
          case "plan":
            set({
              workMode: "plan",
              selectedAgent: "plan",
              safeMode: true,
              permissionPresets: { fileChanges: false, runCommands: false },
            });
            break;
          case "ask":
            set({
              workMode: "ask",
              selectedAgent: "build",
              safeMode: false,
              permissionPresets: { fileChanges: false, runCommands: false },
            });
            break;
          case "auto":
            set({
              workMode: "auto",
              selectedAgent: "build",
              safeMode: false,
              permissionPresets: { fileChanges: true, runCommands: true },
            });
            break;
        }
      },
      setReasoningEnabled: (enabled) => set({ reasoningEnabled: enabled }),
      togglePermissionPreset: (key) =>
        set((s) => {
          const next = { ...s.permissionPresets, [key]: !s.permissionPresets[key] };
          // Sync workMode (only if currently in build agent)
          const workMode: WorkMode = s.selectedAgent === "plan"
            ? "plan"
            : (next.fileChanges ? "auto" : "ask");
          return { permissionPresets: next, workMode };
        }),
      savePermissionRule: (tool, allow) =>
        set((s) => ({
          savedPermissions: [
            ...s.savedPermissions.filter((r) => r.tool !== tool),
            { tool, allow, timestamp: Date.now() },
          ],
        })),
      getSavedPermission: (tool) => {
        const rule = get().savedPermissions.find((r) => r.tool === tool);
        return rule ? rule.allow : null;
      },
      clearPermissionRule: (tool) =>
        set((s) => ({
          savedPermissions: s.savedPermissions.filter((r) => r.tool !== tool),
        })),
      clearAllPermissionRules: () => set({ savedPermissions: [] }),
      setWorkspaceDirectory: (dir) => set({ workspaceDirectory: dir }),
      completeOnboarding: () => set({ hasCompletedOnboarding: true }),
      setHasSeenHints: (seen) => set({ hasSeenHints: seen }),
      setLanguage: (lang) => {
        set({ language: lang });
        localStorage.setItem("openyak-language", lang);
        // Dynamic import to avoid circular dependency
        import("@/i18n/config").then((mod) => mod.default.changeLanguage(lang));
      },
      setActiveProvider: (provider) => set({ activeProvider: provider }),
    }),
    {
      name: "openyak-settings",
    },
  ),
);

// Hydration tracking
const useSettingsHasHydrated = () => {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!useSettingsStore.persist) {
      setHydrated(true);
      return;
    }
    if (useSettingsStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    const unsub = useSettingsStore.persist.onFinishHydration(() => setHydrated(true));
    return () => {
      unsub();
    };
  }, []);
  return hydrated;
};

export { useSettingsHasHydrated };
