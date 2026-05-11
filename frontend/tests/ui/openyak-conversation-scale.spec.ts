import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockState,
} from "./fixtures/openyak-api";

async function setupMockedApp(page: Page): Promise<OpenYakMockState> {
  await seedOpenYakStorage(page);
  return mockOpenYakApi(page);
}

async function sendPrompt(page: Page, text: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(text);
  const promptResponse = page.waitForResponse((res) =>
    res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await page.getByRole("button", { name: /Send message/i }).click();
  await promptResponse;
}

async function expectNoAppCrash(page: Page) {
  await expect(page.getByText("Runtime", { exact: false })).toHaveCount(0);
  await expect(page.getByText("API 401", { exact: false })).toHaveCount(0);
}

test.describe("OpenYak conversation scale and compaction GUI workflows", () => {
  test.describe.configure({ timeout: 75_000 });

  test("manual compression workflow: context indicator starts compaction and persists the marker", async ({ page }) => {
    const state = await setupMockedApp(page);

    await page.goto("/c/session-compact");
    await expect(page.getByText("Context compression checkpoint").first()).toBeVisible();
    await expect(page.getByText("This conversation is above the manual compaction threshold.")).toBeVisible();

    const compactResponse = page.waitForResponse((res) =>
      res.url().includes("/api/chat/compact") && res.status() === 200,
    );
    await page.getByRole("button", { name: "Click to compact now" }).click();
    await compactResponse;

    await expect(page.getByText("Context compressed to save tokens")).toBeVisible({ timeout: 20_000 });
    expect(state.compactRequests).toHaveLength(1);
    await expectNoAppCrash(page);
  });

  test("auto compression workflow: a long prompt stream shows compressed context in the final conversation", async ({ page }) => {
    await setupMockedApp(page);

    await page.goto("/c/new");
    await expect(page.getByRole("heading", { name: /What should (OpenYak help you do|we do in)/i })).toBeVisible();
    await sendPrompt(page, "Trigger auto compress during a long context answer");

    await expect(page).toHaveURL(/\/c\/session-new$/);
    await expect(page.getByText("Auto compacted answer persisted after compression.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Context compressed to save tokens")).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("long conversation workflow: latest messages load first and older pages load through reverse scroll", async ({ page }) => {
    await setupMockedApp(page);

    await page.goto("/c/session-long");
    await expect(page.getByText("Long conversation load test").first()).toBeVisible();
    await expect(page.getByText("Long assistant turn 060")).toBeVisible();
    await expect(page.getByText("Long user turn 001")).toHaveCount(0);

    const scroller = page.getByTestId("message-list-scroller");
    await scroller.hover();
    await page.mouse.wheel(0, -12000);

    await expect(page.getByText("Long user turn 011")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Long assistant turn 060")).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("multi-conversation workflow: switching histories keeps each conversation isolated", async ({ page }) => {
    await setupMockedApp(page);

    await page.goto("/c/session-alpha");
    await expect(page.getByText("Quarterly planning notes").first()).toBeVisible();
    await expect(page.getByText(/retention, onboarding, and pricing clarity/i)).toBeVisible();

    await page.getByRole("option", { name: /Invoice cleanup/i }).click();
    await expect(page).toHaveURL(/\/c\/session-beta$/);
    await expect(page.getByText("Invoice cleanup").first()).toBeVisible();
    await expect(page.getByText(/retention, onboarding, and pricing clarity/i)).toHaveCount(0);

    await page.getByRole("option", { name: /Long conversation load test/i }).click();
    await expect(page).toHaveURL(/\/c\/session-long$/);
    await expect(page.getByText("Long assistant turn 060")).toBeVisible();
    await expect(page.getByText("Invoice cleanup").first()).toBeVisible();
    await expect(page.getByText("Summarize the quarterly plan")).toHaveCount(0);

    await page.getByRole("option", { name: /Artifact showcase/i }).click();
    await expect(page).toHaveURL(/\/c\/session-artifacts$/);
    await expect(page.getByText("Release Brief")).toBeVisible();
    await expect(page.getByText("Long assistant turn 060")).toHaveCount(0);
    await expectNoAppCrash(page);
  });
});
