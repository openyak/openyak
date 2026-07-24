import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
} from "./fixtures/openyak-api";

async function sendSlowPrompt(page: Page) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(
    "Start a slow stream so I can test stop generation",
  );
  const promptResponse = page.waitForResponse((response) =>
    response.url().includes("/api/chat/prompt") && response.status() === 200,
  );
  await page.getByRole("button", { name: /Send message/i }).click();
  await promptResponse;
}

test.describe("Stop generation UX", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "The desktop composer is the canonical Work Mode stop surface.",
  );

  test("re-enables the composer immediately without waiting for abort", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page, { abortDelayMs: 4_000 });

    await page.goto("/c/new");
    await sendSlowPrompt(page);
    await expect(
      page.getByText("Starting a deliberately slow GUI stream."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Stop" }).click();

    await expect(
      page.getByRole("button", { name: /Send message/i }),
    ).toBeVisible({ timeout: 750 });
    const composer = page.getByPlaceholder(/Describe the result you want/i);
    await expect(composer).toBeEnabled({ timeout: 750 });
    await composer.fill("Continue from the preserved partial response");
    await expect(
      page.getByRole("button", { name: /Send message/i }),
    ).toBeEnabled({ timeout: 750 });
  });

  test("keeps the partial assistant response after the stream is stopped", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);

    await page.goto("/c/new");
    await sendSlowPrompt(page);
    const partial = page.getByText(
      "Starting a deliberately slow GUI stream.",
    );
    await expect(partial).toBeVisible();

    await page.getByRole("button", { name: "Stop" }).click();

    await page.waitForTimeout(2_500);
    await expect(partial).toBeVisible();
  });

  test("marks an ordinary interrupted response with a Stopped terminus", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);

    await page.goto("/c/new");
    await sendSlowPrompt(page);
    await expect(
      page.getByText("Starting a deliberately slow GUI stream."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Stop" }).click();

    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(page.locator(".streaming-cursor")).toHaveCount(0);
  });

  test("does not keep Finalizing after the user stops an active swarm", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);

    await page.goto("/c/new");
    await page
      .getByPlaceholder(/Describe the result you want/i)
      .fill("Start a slow swarm so I can test swarm stop");
    const promptResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/chat/prompt") &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: /Send message/i }).click();
    await promptResponse;

    const swarm = page.getByRole("status", {
      name: "Agent swarm: Running",
    });
    await expect(swarm).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();

    await expect(
      page.getByRole("status", { name: "Agent swarm: Cancelled" }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Finalizing" }),
    ).toHaveCount(0);
  });

  test("remembers stop before the stream id arrives and aborts it once known", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    const state = await mockOpenYakApi(page, { promptDelayMs: 1_500 });

    await page.goto("/c/new");
    await page.getByPlaceholder(/Describe the result you want/i).fill(
      "Start a slow stream so I can test stop generation",
    );
    const promptResponse = page.waitForResponse((response) =>
      response.url().includes("/api/chat/prompt") && response.status() === 200,
    );
    await page.getByRole("button", { name: /Send message/i }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    await page.getByRole("button", { name: "Stop" }).click();

    await expect(
      page.getByRole("button", { name: /Send message/i }),
    ).toBeVisible({ timeout: 750 });
    await promptResponse;
    await expect.poll(() => state.abortRequests.length).toBe(1);
    await expect(page).toHaveURL(/\/c\/session-new$/);
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  });

  test("does not keep Thinking above an actively streaming text response", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);

    await page.goto("/c/new");
    await page.getByPlaceholder(/Describe the result you want/i).fill(
      "Start a text-only stream",
    );
    const promptResponse = page.waitForResponse((response) =>
      response.url().includes("/api/chat/prompt") && response.status() === 200,
    );
    await page.getByRole("button", { name: /Send message/i }).click();
    await promptResponse;
    await expect(
      page.getByText("Only visible text is streaming."),
    ).toBeVisible();

    await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
  });
});
