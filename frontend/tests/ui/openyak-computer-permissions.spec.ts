import { expect, test, type Page } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test("Computer Use settings show live OS access and app-scoped approvals", async ({
  page,
}) => {
  await seedOpenYakStorage(page, {
    force: true,
    savedPermissions: [
      { tool: "computer", allow: true, pattern: "com.apple.TextEdit", timestamp: 1 },
      { tool: "computer", allow: true, pattern: "Notes", timestamp: 2 },
      { tool: "bash", allow: true, pattern: "git *", timestamp: 3 },
    ],
  });
  await mockOpenYakApi(page);
  await page.route("**/api/computer-control/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        platform: "macos",
        supported: true,
        interaction_mode: "background",
        accessibility: "granted",
        screen_recording: "denied",
        runtime: "available",
        settings_url:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      }),
    });
  });

  await page.goto("/settings?tab=permissions");

  await expect(page.getByRole("heading", { name: "System access" })).toBeVisible();
  await expect(page.getByText("Accessibility")).toBeVisible();
  await expect(page.getByText("Screen Recording")).toBeVisible();
  await expect(page.getByText("Granted", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs access", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Always allowed apps" })).toBeVisible();
  await expect(page.getByText("com.apple.TextEdit", { exact: true })).toBeVisible();
  await expect(page.getByText("Notes", { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: "Remove com.apple.TextEdit from always allowed apps" })
    .click();
  await expect(page.getByText("com.apple.TextEdit", { exact: true })).toBeHidden();
  await expect(page.getByText("Notes", { exact: true })).toBeVisible();
  await expect(page.getByText("Shell", { exact: true })).toBeVisible();
});

async function sendPrompt(page: Page, text: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(text);
  await page.locator('button[aria-label="Send message"]:not([disabled])').click();
}

test("Computer Use approval offers Allow once, Always allow app, and Deny", async ({
  page,
}) => {
  await seedOpenYakStorage(page, {
    force: true,
    workMode: "ask",
    computerUseEnabled: true,
  });
  const state = await mockOpenYakApi(page);
  await page.goto("/c/new");
  await sendPrompt(page, "computer app approval");

  await expect(page.getByText("Allow OpenYak to see and control TextEdit?")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Deny/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Allow once/ })).toBeVisible();
  const always = page.getByRole("button", { name: "Always allow com.apple.TextEdit" });
  await expect(always).toBeVisible();
  await always.click();

  await expect.poll(() => state.chatResponses.length).toBeGreaterThan(0);
  const response = state.chatResponses.at(-1) as { response: Record<string, unknown> };
  expect(response.response).toMatchObject({
    allowed: true,
    remember: true,
    permission: "computer",
    pattern: "com.apple.TextEdit",
  });
});
