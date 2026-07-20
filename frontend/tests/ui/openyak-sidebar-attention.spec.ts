import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test("a background run blocked on approval flags itself in the sidebar", async ({
  page,
}) => {
  // "ask" mode so the run actually stops for a permission decision.
  await seedOpenYakStorage(page, { workMode: "ask" });
  await mockOpenYakApi(page);

  await page.goto("/c/new");
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });

  await page
    .getByPlaceholder(/Describe the result you want/i)
    .fill("Please run the permission demo command");
  await page
    .locator('button[aria-label="Send message"]:not([disabled])')
    .click();
  await expect(page.getByText("Permission Required")).toBeVisible();

  // The sidebar row for this session must advertise that it is blocked —
  // this is the signal that makes an unattended run recoverable.
  const flagged = page.getByLabel("Waiting for your approval");
  await expect(flagged).toBeVisible();

  // It must survive navigating away: the whole point is noticing a blocked
  // run from somewhere else in the app.
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect(
    page
      .getByRole("heading", {
        name: /What should (OpenYak help you do|we do in)/i,
      })
      .first(),
  ).toBeVisible();
  await expect(page.getByLabel("Waiting for your approval")).toBeVisible();
});

test("a plain background run shows the generating spinner, not the alert", async ({
  page,
}) => {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);

  await page.goto("/c/new");
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });

  await page
    .getByPlaceholder(/Describe the result you want/i)
    .fill("Start a slow stream so I can watch the sidebar");
  await page
    .locator('button[aria-label="Send message"]:not([disabled])')
    .click();

  await expect(page.getByLabel("Generating in background")).toBeVisible();
  await expect(page.getByLabel("Waiting for your approval")).toHaveCount(0);
});
