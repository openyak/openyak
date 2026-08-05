import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test.describe("OpenYak shared Browser workspace", () => {
  test.skip(({ isMobile }) => isMobile, "The shared Browser is a desktop workspace.");

  test("selects Browser, navigates on Enter, and hands control back", async ({ page }) => {
    await seedOpenYakStorage(page);
    const state = await mockOpenYakApi(page);
    await page.goto("/c/new");

    await page.getByRole("button", { name: "Use: Auto" }).click();
    await page
      .getByRole("radio", {
        name: "Browser Use the shared managed Browser and show its live view.",
      })
      .click();

    const panel = page.getByRole("complementary", { name: "Task panel" });
    await expect(panel.getByRole("region", { name: "Browser" })).toBeVisible();
    await expect(panel.getByText("Agent is controlling the Browser")).toBeVisible();

    await panel.getByRole("button", { name: "Take over" }).click();
    await expect(panel.getByRole("button", { name: "Return to Agent" })).toBeVisible();

    const address = panel.getByRole("textbox", { name: "Browser address" });
    await address.fill("example.com/manual-check");
    await address.press("Enter");

    await expect.poll(() => state.browserInteractions).toContainEqual({
      action: "navigate",
      tab_id: "browser-tab-1",
      url: "https://example.com/manual-check",
    });

    await panel.getByRole("button", { name: "Return to Agent" }).click();
    await expect(panel.getByText("Agent is controlling the Browser")).toBeVisible();
    expect(state.browserControls).toEqual([{ owner: "user" }, { owner: "agent" }]);
  });
});
