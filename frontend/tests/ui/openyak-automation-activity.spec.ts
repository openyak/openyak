import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test.beforeEach(async ({ page }) => {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
});

test("the Activity tab shows a cross-task run feed and links to the run's session", async ({
  page,
}) => {
  await page.goto("/automations");
  await page.getByRole("button", { name: "Activity" }).click();

  // Runs from two different tasks appear, newest first.
  const failed = page.getByText("Invoice sweep");
  const ok = page.getByText("Morning brief");
  await expect(failed).toBeVisible();
  await expect(ok).toBeVisible();

  // The failed run surfaces its status and error inline.
  await expect(page.getByText(/Failed/)).toBeVisible();
  await expect(page.getByText(/Provider timed out/)).toBeVisible();

  // Clicking a run with a session opens that conversation.
  await failed.click();
  await expect.poll(() => page.url()).toMatch(/\/c\//);
});

test("Activity empty state renders when there are no runs", async ({ page }) => {
  // Override the feed to be empty for this test.
  await page.route("**/api/automations/runs/recent", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  );

  await page.goto("/automations");
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByText("No automation runs yet")).toBeVisible();
});
