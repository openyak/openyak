import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test.describe("OpenYak shared Computer workspace", () => {
  test.skip(({ isMobile }) => isMobile, "The shared Computer is a desktop workspace.");

  test("switches apps and hands live native control between Agent and user", async ({
    page,
  }) => {
    await seedOpenYakStorage(page, { computerUseEnabled: true, force: true });
    const state = await mockOpenYakApi(page);
    await page.goto("/c/new");

    await page.getByRole("button", { name: "Use: Auto" }).click();
    await page.getByRole("radio", { name: /^Computer / }).click();

    const panel = page.getByRole("complementary", { name: "Task panel" });
    const workspace = panel.getByRole("region", { name: "Computer" });
    await expect(workspace).toBeVisible();
    await expect(workspace.getByText("Agent is controlling Computer")).toBeVisible();
    await expect(workspace.getByRole("img", { name: /Live view of TextEdit/ })).toBeVisible();

    await workspace.getByRole("combobox", { name: "Target application" }).selectOption(
      "com.apple.Notes",
    );
    await expect.poll(() => state.computerSelections).toContainEqual({
      application: "com.apple.Notes",
    });

    await workspace.getByRole("button", { name: "Take over" }).click();
    await expect(workspace.getByRole("button", { name: "Return to Agent" })).toBeVisible();

    const frame = workspace.getByRole("button", { name: "Live Computer viewport" });
    await frame.click({ position: { x: 1, y: 1 } });
    await frame.press("a");
    await expect.poll(() => state.computerInteractions.length).toBeGreaterThanOrEqual(2);
    expect(state.computerInteractions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "click" }),
      { action: "key", key: "a", modifiers: [] },
    ]));

    await workspace.getByRole("button", { name: "Return to Agent" }).click();
    await expect(workspace.getByText("Agent is controlling Computer")).toBeVisible();

    await workspace.getByRole("button", { name: "Take over" }).click();
    await workspace.getByRole("button", { name: "Close Computer" }).click();
    await expect(workspace).not.toBeVisible();
    expect(state.computerControls).toEqual([
      { owner: "user" },
      { owner: "agent" },
      { owner: "user" },
      { owner: "agent" },
    ]);
  });
});
