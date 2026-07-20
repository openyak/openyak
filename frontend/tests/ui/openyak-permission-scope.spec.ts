import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockState,
} from "./fixtures/openyak-api";

let mockState: OpenYakMockState;

test.beforeEach(async ({ page }) => {
  await seedOpenYakStorage(page);
  mockState = await mockOpenYakApi(page);
});

async function openNewChat(page: Page) {
  await page.goto("/c/new");
  await expect(
    page
      .getByRole("heading", {
        name: /What should (OpenYak help you do|we do in)/i,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });
}

async function sendPrompt(page: Page, text: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(text);
  const promptResponse = page.waitForResponse(
    (res) => res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await page
    .locator('button[aria-label="Send message"]:not([disabled])')
    .click();
  await promptResponse;
}

test("scoped remember: command-family approval persists and rides the next prompt", async ({
  page,
}) => {
  // "ask" mode so the permission dialog actually surfaces (auto would
  // silently approve via the stream registry).
  await seedOpenYakStorage(page, { workMode: "ask" });
  await openNewChat(page);
  await sendPrompt(page, "Please run the permission demo command");

  // The permission dialog surfaces the exact command under review.
  await expect(page.getByText("Permission Required")).toBeVisible();
  await expect(page.getByText("npm run preflight:ui").first()).toBeVisible();

  // Turning Remember on reveals the scope selector, defaulting to the
  // safest option (this exact command).
  await page.locator("#remember-choice").click();
  const scopeSelect = page.locator("#remember-scope");
  await expect(scopeSelect).toBeVisible();
  await expect(scopeSelect).toHaveValue("exact");

  // Choose the command-family scope and confirm the pattern preview.
  await scopeSelect.selectOption("prefix");
  await expect(page.getByText("npm *", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Allow/ }).click();

  // The respond payload carries the chosen scope to the backend.
  await expect.poll(() => mockState.chatResponses.length).toBeGreaterThan(0);
  const respond = mockState.chatResponses.at(-1) as {
    response: Record<string, unknown>;
  };
  expect(respond.response).toMatchObject({
    allowed: true,
    remember: true,
    permission: "bash",
    pattern: "npm *",
  });

  // The rule is persisted with its pattern in settings storage.
  const stored = (await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("openyak-settings") ?? "{}"),
  )) as { state: { savedPermissions: unknown[] } };
  expect(stored.state.savedPermissions).toEqual([
    expect.objectContaining({ tool: "bash", allow: true, pattern: "npm *" }),
  ]);

  // A fresh prompt sends the scoped rule to the backend. Navigate in-app —
  // a full page.goto would re-run the storage seed and wipe the saved rule.
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect(
    page
      .getByRole("heading", {
        name: /What should (OpenYak help you do|we do in)/i,
      })
      .first(),
  ).toBeVisible();
  await sendPrompt(page, "Summarize the workspace files");
  const lastPrompt = mockState.promptBodies.at(-1) as {
    permission_rules: unknown[];
  };
  expect(lastPrompt.permission_rules).toEqual([
    expect.objectContaining({
      action: "allow",
      permission: "bash",
      pattern: "npm *",
    }),
  ]);
});

test("legacy tool-wide rules migrate to pattern '*' and still ride prompts", async ({
  page,
}) => {
  await seedOpenYakStorage(page, {
    savedPermissions: [{ tool: "bash", allow: true, timestamp: 1 }],
    force: true,
  });
  await openNewChat(page);
  await sendPrompt(page, "Summarize the workspace files");

  const lastPrompt = mockState.promptBodies.at(-1) as {
    permission_rules: unknown[];
  };
  expect(lastPrompt.permission_rules).toEqual([
    expect.objectContaining({ permission: "bash", pattern: "*" }),
  ]);
});
