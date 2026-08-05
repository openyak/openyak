import { expect, test } from "@playwright/test";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";


test("opening a Browser observation selects its live tab in the workspace", () => {
  useBrowserWorkspaceStore.getState().reset();

  useBrowserWorkspaceStore.getState().open("tab-7");

  const state = useBrowserWorkspaceStore.getState();
  expect(state.isOpen).toBe(true);
  expect(state.activeTabId).toBe("tab-7");
});
