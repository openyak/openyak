import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockOptions,
  type OpenYakMockState,
} from "./fixtures/openyak-api";

async function setupMockedApp(
  page: Page,
  options?: OpenYakMockOptions,
  seedOptions?: Parameters<typeof seedOpenYakStorage>[1],
): Promise<OpenYakMockState> {
  await seedOpenYakStorage(page, seedOptions);
  return mockOpenYakApi(page, options);
}

async function expectNoAppCrash(page: Page) {
  await expect(page.getByText("Runtime", { exact: false })).toHaveCount(0);
  await expect(page.getByText("API 401", { exact: false })).toHaveCount(0);
}

test.describe("OpenYak edge-state GUI regressions", () => {
  test.describe.configure({ timeout: 75_000 });

  test("billing return workflow: checkout success refreshes billing and cleans the return URL", async ({ page }) => {
    await setupMockedApp(page);

    await page.goto("/settings?tab=billing&checkout=success");
    await expect(page).toHaveURL(/\/settings\?tab=billing$/);
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expect(page.getByText("$12.50", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Chat: Best Free")).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("billing disconnected workflow: signed-out account shows the billing empty state and routes to providers", async ({ page }) => {
    await setupMockedApp(page, undefined, { authConnected: false });

    await page.goto("/settings?tab=billing");
    await expect(page.locator("p:visible").filter({ hasText: "Connect an OpenYak account to top up and access premium models." })).toBeVisible();
    await page.getByRole("button", { name: "Go to Settings" }).click();
    await expect(page).toHaveURL(/\/settings\?tab=providers$/);
    await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("auth expiry workflow: backend 401 while sending is recoverable and keeps the composer usable", async ({ page }) => {
    await setupMockedApp(page, {
      promptErrors: [{ match: "expired auth", status: 401, detail: "Session expired" }],
    });

    await page.goto("/c/new");
    await page.getByPlaceholder(/Describe the result you want/i).fill("expired auth should not crash");
    const failedPrompt = page.waitForResponse((res) =>
      res.url().includes("/api/chat/prompt") && res.status() === 401,
    );
    await page.getByRole("button", { name: /Send message/i }).click();
    await failedPrompt;

    await expect(page.getByText("Failed to send message")).toBeVisible();
    await expect(page.getByPlaceholder(/Describe the result you want/i)).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("mobile needs-input workflow: task list badge opens the detail prompt and responds from the GUI", async ({ page }) => {
    const state = await setupMockedApp(page, {
      activeJobs: [{ stream_id: "stream-question", session_id: "session-alpha", needs_input: true }],
    });

    await page.goto("/m?token=remote-token");
    await expect(page.getByRole("heading", { name: "OpenYak" })).toBeVisible();
    await expect(page.getByText("Needs input")).toBeVisible();
    await page.getByText("Quarterly planning notes").click();

    await expect(page.getByText("Agent is asking")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Which release channel should this automation watch?")).toBeVisible();
    const response = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Stable/i }).click();
    await response;

    expect(state.chatResponses).toHaveLength(1);
    await expectNoAppCrash(page);
  });

  test("mobile remote disconnect workflow: an unreachable desktop tunnel shows disconnected health without leaving tasks", async ({ page }) => {
    await setupMockedApp(page, { remoteProviderInfoStatus: 503 });

    await page.goto("/m?token=remote-token");
    await expect(page.getByRole("heading", { name: "OpenYak" })).toBeVisible();
    await expect(page.getByText("Quarterly planning notes")).toBeVisible();
    await expect(page.locator('span[title="disconnected"]')).toBeVisible({ timeout: 20_000 });
    await expectNoAppCrash(page);
  });

  test("connector auth failure workflow: failed OAuth is surfaced as a toast instead of an unhandled UI error", async ({ page }) => {
    await setupMockedApp(page, {
      connectorErrors: [{ match: "notion/connect", status: 500, detail: "Notion OAuth unavailable" }],
    });

    await page.goto("/settings?tab=plugins");
    await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
    await page.locator('input[placeholder="Search..."]:visible').fill("notion");
    const notionRow = page.locator("div").filter({ hasText: "Notion" }).filter({ hasText: "Search and update pages" }).first();
    await expect(notionRow).toBeVisible();
    await notionRow.getByRole("switch").click();

    await expect(page.getByText("Notion OAuth unavailable")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("chatgpt auth launch failure stops the waiting state", async ({ page }) => {
    await setupMockedApp(page, {
      openaiSubscriptionConnected: false,
      openaiLoginStatus: 500,
    });

    await page.goto("/settings?tab=providers");
    await page.getByRole("button", { name: /ChatGPT Subscription/i }).click();
    await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();

    await expect(page.getByText("Failed to start authentication")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled();
    await expect(page.getByText("Waiting for authentication...")).toHaveCount(0);
    await expectNoAppCrash(page);
  });

  test("ollama status failure shows a retryable error instead of an endless spinner", async ({ page }) => {
    await setupMockedApp(page, {
      ollamaStatusCode: 500,
    });

    await page.goto("/settings?tab=providers");
    await page.getByRole("button", { name: "Ollama" }).click();

    await expect(page.getByText("Failed to load Ollama status.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expectNoAppCrash(page);
  });
});
