import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test.describe("Workspace Session state", () => {
  test("restores a Session's scratchpad after navigating to another Session and back", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);
    await page.goto("/c/session-alpha");

    const alphaScratchpad = page.getByRole("button", { name: "Scratchpad" });
    if (!(await alphaScratchpad.isVisible())) {
      await page.getByRole("button", { name: /Outputs\. 5 generated files/i }).click();
    }
    await alphaScratchpad.click();
    await page.getByPlaceholder("Notes, ideas, reminders...").fill("Alpha notes");

    await page.getByRole("option", { name: /Invoice cleanup/i }).click();
    await expect(page).toHaveURL(/\/c\/session-beta$/);
    const betaScratchpad = page.getByRole("button", { name: "Scratchpad" });
    if (!(await betaScratchpad.isVisible())) {
      await page.getByRole("button", { name: /Outputs\. 5 generated files/i }).click();
    }
    await betaScratchpad.click();
    await page.getByPlaceholder("Notes, ideas, reminders...").fill("Beta notes");

    await page.getByRole("option", { name: /Quarterly planning notes/i }).click();
    await expect(page).toHaveURL(/\/c\/session-alpha$/);
    await expect(page.getByPlaceholder("Notes, ideas, reminders...")).toHaveValue(
      "Alpha notes",
    );
  });
});
