import { expect, test } from "@playwright/test";
import { useSettingsStore } from "@/stores/settings-store";


test("the composer keeps the user's explicit Browser surface selection", () => {
  useSettingsStore.getState().setInteractionSurface("auto");

  useSettingsStore.getState().setInteractionSurface("browser");

  expect(useSettingsStore.getState().interactionSurface).toBe("browser");
});
