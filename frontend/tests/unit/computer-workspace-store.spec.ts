import { expect, test } from "@playwright/test";
import { useComputerWorkspaceStore } from "@/stores/computer-workspace-store";


test("opening a Computer observation selects its live native application", () => {
  useComputerWorkspaceStore.getState().reset();

  useComputerWorkspaceStore.getState().open("com.apple.TextEdit");

  const state = useComputerWorkspaceStore.getState();
  expect(state.isOpen).toBe(true);
  expect(state.applicationId).toBe("com.apple.TextEdit");
});


test("closing Computer keeps the selected application for reopening", () => {
  useComputerWorkspaceStore.getState().reset();
  useComputerWorkspaceStore.getState().open("com.apple.TextEdit");

  useComputerWorkspaceStore.getState().close();
  useComputerWorkspaceStore.getState().open();

  const state = useComputerWorkspaceStore.getState();
  expect(state.isOpen).toBe(true);
  expect(state.applicationId).toBe("com.apple.TextEdit");
});
