import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
} from "./fixtures/openyak-api";

async function setupMockedApp(page: Page) {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
}

async function startSlowStream(page: Page) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(
    "Start a slow stream so I can test stop generation",
  );
  const promptResponse = page.waitForResponse((response) =>
    response.url().includes("/api/chat/prompt") && response.status() === 200,
  );
  await page.getByRole("button", { name: /Send message/i }).click();
  await promptResponse;
  await expect(
    page.getByText("Starting a deliberately slow GUI stream."),
  ).toBeVisible();
}

test.describe("Codex-aligned conversation polish", () => {
  test("assistant prose stays on the shared reading rail at a readable body scale", async ({ page }) => {
    await setupMockedApp(page);
    await page.goto("/c/session-alpha");

    const answer = page.getByText(
      "The plan has three priorities: retention, onboarding, and pricing clarity.",
    );
    await expect(answer).toBeVisible();

    const rail = answer.locator(
      "xpath=ancestor::*[@data-conversation-rail][1]",
    );
    await expect(rail).toHaveCount(1);

    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    expect(railBox!.width).toBeGreaterThanOrEqual(728);
    expect(railBox!.width).toBeLessThanOrEqual(760);

    const typography = await answer.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        fontSize: style.fontSize,
        lineHeight: Number.parseFloat(style.lineHeight),
      };
    });
    expect(typography.fontSize).toBe("15px");
    expect(typography.lineHeight).toBeGreaterThanOrEqual(23);
    expect(typography.lineHeight).toBeLessThanOrEqual(24);
  });

  test("message actions remain discoverable and the user bubble stays visually restrained", async ({ page }) => {
    await setupMockedApp(page);
    await page.goto("/c/session-alpha");

    const userBubble = page.getByText("Summarize the quarterly plan").locator(
      "xpath=ancestor::*[@data-message-author='user'][1]",
    );
    await expect(userBubble).toHaveCount(1);

    const bubbleStyle = await userBubble.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        boxShadow: style.boxShadow,
        fontSize: style.fontSize,
        conversationBodySize: style.getPropertyValue("--conversation-body-size"),
      };
    });
    expect(bubbleStyle.conversationBodySize.trim()).toBe("15px");
    expect(bubbleStyle.boxShadow).toBe("none");
    expect(bubbleStyle.fontSize).toBe("15px");

    for (const actionName of ["Copy message", "Copy"]) {
      const action = page.getByRole("button", {
        name: actionName,
        exact: true,
      });
      await expect(action).toBeAttached();
      const actionBar = action.locator(
        "xpath=ancestor::*[@data-message-actions][1]",
      );
      const visibility = await actionBar.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          opacity: Number.parseFloat(style.opacity),
          pointerEvents: style.pointerEvents,
        };
      });
      expect(visibility.opacity).toBeGreaterThanOrEqual(0.45);
      expect(visibility.pointerEvents).not.toBe("none");
    }
  });

  test("a stopped response ends with a compact lifecycle log row", async ({ page }) => {
    await setupMockedApp(page);
    await page.goto("/c/new");
    await startSlowStream(page);

    await page.getByRole("button", { name: "Stop" }).click();

    const stopped = page.locator("[data-conversation-lifecycle]", {
      hasText: "Stopped",
    });
    await expect(stopped).toBeVisible();
    await expect(stopped.getByText("Stopped", { exact: true })).toBeVisible();

    const style = await stopped.evaluate((node) => {
      const computed = getComputedStyle(node);
      return {
        fontSize: computed.fontSize,
        backgroundColor: computed.backgroundColor,
      };
    });
    const box = await stopped.boundingBox();
    expect(style.fontSize).toBe("13px");
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(28);
  });
});
