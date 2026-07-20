import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test.beforeEach(async ({ page }) => {
  // First run: onboarding not yet completed.
  await seedOpenYakStorage(page, { hasCompletedOnboarding: false });
  await mockOpenYakApi(page);
});

test("first run shows the 3-step flow; finishing dismisses it and persists", async ({
  page,
}) => {
  await page.goto("/c/new");

  // Step 1 — identity.
  await expect(page.getByText("Welcome to OpenYak")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "I'll do this later" }).click();

  // Step 2 — the trust model (all three permission modes explained).
  await expect(page.getByText("You're in control of what it does")).toBeVisible();
  await expect(page.getByText("Ask first")).toBeVisible();
  await expect(page.getByText("Plan first")).toBeVisible();

  await page.getByRole("button", { name: /^Next/ }).click();

  // Step 3 — how to drive it (teaches the / menu shipped in P1.3).
  await expect(page.getByText("Two things worth knowing")).toBeVisible();
  await expect(page.getByText(/Type \/ in the message box/)).toBeVisible();

  await page.getByRole("button", { name: /Start working/ }).click();

  // Onboarding is gone and the app is usable.
  await expect(page.getByText("Two things worth knowing")).toHaveCount(0);
  await expect(
    page.getByPlaceholder(/Describe the result you want/i),
  ).toBeVisible();

  // Persisted, so it does not reappear on reload.
  const persisted = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("openyak-settings") ?? "{}");
    return s.state?.hasCompletedOnboarding;
  });
  expect(persisted).toBe(true);
});

test("Skip completes onboarding immediately from step 1", async ({ page }) => {
  await page.goto("/c/new");
  await expect(page.getByText("Welcome to OpenYak")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText("Welcome to OpenYak")).toHaveCount(0);
  await expect(
    page.getByPlaceholder(/Describe the result you want/i),
  ).toBeVisible();
});

test("Back returns to the previous step", async ({ page }) => {
  await page.goto("/c/new");
  await expect(page.getByText("Welcome to OpenYak")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "I'll do this later" }).click();
  await expect(page.getByText("You're in control of what it does")).toBeVisible();
  await page.getByRole("button", { name: /Back/ }).click();
  await expect(page.getByText("Welcome to OpenYak")).toBeVisible();
});
