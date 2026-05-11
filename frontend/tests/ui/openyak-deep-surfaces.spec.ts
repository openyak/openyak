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

async function sendPrompt(page: Page, text: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(text);
  const promptResponse = page.waitForResponse((res) =>
    res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await page.getByRole("button", { name: /Send message/i }).click();
  await promptResponse;
}

async function seedByokProvider(page: Page) {
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("openyak-settings");
    const settings = raw ? JSON.parse(raw) : { state: {}, version: 0 };
    settings.state = {
      ...settings.state,
      hasCompletedOnboarding: true,
      activeProvider: "byok",
      selectedModel: "openrouter/anthropic/claude-sonnet-4.5",
      selectedProviderId: "openrouter",
    };
    window.localStorage.setItem("openyak-settings", JSON.stringify(settings));
  });
}

test.describe("OpenYak deep claimed-feature GUI surfaces", () => {
  test.describe.configure({ timeout: 90_000 });
  test.skip(({ isMobile }) => isMobile, "Desktop-only surfaces are covered alongside separate mobile GUI workflows.");

  test("message workflow: edit/resend from a historical user bubble and stop an active stream", async ({ page }) => {
    const state = await setupMockedApp(page);

    await page.goto("/c/session-alpha");
    await expect(page.getByText("Summarize the quarterly plan")).toBeVisible();

    await page.getByText("Summarize the quarterly plan").hover();
    await page.getByRole("button", { name: "Edit message" }).click();
    const editBox = page.locator("textarea").first();
    await editBox.fill("Summarize the quarterly plan with edited scope");

    const editResponse = page.waitForResponse((res) =>
      res.url().includes("/api/chat/edit") && res.status() === 200,
    );
    await editBox.press("Enter");
    await editResponse;

    await expect(page.getByText("Summarize the quarterly plan with edited scope")).toBeVisible();
    await expect(page.getByText("Edited response streamed from the mock backend.")).toBeVisible({ timeout: 20_000 });
    expect(JSON.stringify(state.editBodies[0])).toContain("session-alpha-user-1");
    expect(JSON.stringify(state.editBodies[0])).toContain("edited scope");

    await page.goto("/c/new");
    await sendPrompt(page, "Start a slow stream so I can test stop generation");
    await expect(page.getByText("Starting a deliberately slow GUI stream.")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => state.abortRequests.length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: /Send message/i })).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("assistant action workflow: activity, good/bad feedback, and visible recovery controls", async ({ page }) => {
    await setupMockedApp(page);

    await page.goto("/c/session-artifacts");
    await expect(page.getByText("Artifact showcase").first()).toBeVisible();
    await page.getByText("I prepared the release pack").hover();

    await page.getByRole("button", { name: "View activity" }).click();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(page.getByText("Release Brief").last()).toBeVisible();

    await page.getByText("I prepared the release pack").hover();
    const good = page.getByRole("button", { name: "Good response" });
    const bad = page.getByRole("button", { name: "Bad response" });
    await good.click();
    await expect(good).toHaveAttribute("aria-pressed", "true");
    await bad.click();
    await expect(bad).toHaveAttribute("aria-pressed", "true");
    await expectNoAppCrash(page);
  });

  test("model selector workflow: search, sort modes, model switch, and send payload stay aligned", async ({ page }) => {
    const state = await setupMockedApp(page);
    await seedByokProvider(page);

    await page.goto("/c/new");
    await expect(page.getByRole("button", { name: /Claude Sonnet 4\.5/i })).toBeVisible();
    await page.getByRole("button", { name: /Claude Sonnet 4\.5/i }).click();
    await expect(page.getByPlaceholder("Search models...")).toBeVisible();

    await page.getByRole("button", { name: /^Price$/i }).click();
    await page.getByRole("button", { name: /^Name$/i }).click();
    await page.getByPlaceholder("Search models...").fill("Acme");
    await expect(page.getByText("Acme Coder")).toBeVisible();
    await page.getByText("Acme Coder").click();
    await expect(page.getByRole("button", { name: /Acme Coder/i })).toBeVisible();

    await sendPrompt(page, "Use the selected custom model from the GUI");
    expect(JSON.stringify(state.promptBodies[0])).toContain("custom_acme/acme-coder");
    expect(JSON.stringify(state.promptBodies[0])).toContain("custom_acme");
    await expectNoAppCrash(page);
  });

  test("sidebar workflow: pin, rename, export, delete confirmation, and undo are reachable from the real menu", async ({ page }) => {
    const state = await setupMockedApp(page);

    await page.goto("/c/session-alpha");
    const alpha = page.getByRole("option", { name: /Quarterly planning notes/i });
    await expect(alpha).toBeVisible();

    await alpha.hover();
    await alpha.locator("button").last().click();
    await page.getByRole("menuitem", { name: /Unpin/i }).click();
    await expect.poll(() => JSON.stringify(state.sessionUpdates)).toContain('"is_pinned":false');

    const alphaAfterPin = page.getByRole("option", { name: /Quarterly planning notes/i });
    await alphaAfterPin.hover();
    await alphaAfterPin.locator("button").last().click();
    await page.getByRole("menuitem", { name: /Rename/i }).click();
    await expect(alphaAfterPin.locator('input[type="text"]')).toBeVisible();
    await alphaAfterPin.locator('input[type="text"]').fill("Quarterly planning notes renamed");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: /Quarterly planning notes renamed/i })).toBeVisible();
    expect(JSON.stringify(state.sessionUpdates)).toContain("Quarterly planning notes renamed");

    const renamed = page.getByRole("option", { name: /Quarterly planning notes renamed/i });
    await renamed.hover();
    await renamed.locator("button").last().click();
    const mdDownload = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /Export Markdown/i }).click();
    await mdDownload;
    await expect.poll(() => state.sessionExports).toContain("session-alpha.md");

    await renamed.hover();
    await renamed.locator("button").last().click();
    const pdfDownload = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /Export PDF/i }).click();
    await pdfDownload;
    await expect.poll(() => state.sessionExports).toContain("session-alpha.pdf");

    await renamed.hover();
    await renamed.locator("button").last().click();
    await page.getByRole("menuitem", { name: /^Delete$/i }).click();
    await expect(page.getByText("Delete conversation?")).toBeVisible();
    await page.getByRole("button", { name: /^Delete$/i }).click();
    await expect(page.getByText("Conversation deleted")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("option", { name: /Quarterly planning notes renamed/i })).toBeVisible();
    expect(state.sessionDeletes).toHaveLength(0);
    await expectNoAppCrash(page);
  });

  test("workspace workflow: progress, scratchpad, file preview, and artifact side panel work together", async ({ page }) => {
    await setupMockedApp(page);

    await page.goto("/c/session-alpha");
    await expect(page.getByText("Progress")).toBeVisible();
    await page.getByRole("button", { name: /Progress/i }).click();
    await expect(page.getByText("Draft outline")).toBeVisible();

    const filesCard = page.getByRole("button", { name: /Files 5 generated files/i });
    await expect(filesCard).toBeVisible();
    await filesCard.click();
    await page.getByRole("button", { name: "Scratchpad" }).click();
    const scratchpad = page.getByPlaceholder("Notes, ideas, reminders...");
    await scratchpad.fill("Remember to verify the GUI artifact path.");
    await expect(scratchpad).toHaveValue("Remember to verify the GUI artifact path.");

    await page.getByRole("button", { name: "plan.md" }).click();
    await expect(page.getByText("Workspace file preview loaded through the GUI.")).toBeVisible();
    await expect(page.getByText("plan.md").first()).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("remote workflow: QR, permission mode, token rotation, channel setup, and disable path", async ({ page }) => {
    const state = await setupMockedApp(page);

    await page.goto("/settings?tab=remote");
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();
    await page.getByRole("switch").first().click();
    await expect(page.getByText("Remote Access Active")).toBeVisible();

    await expect(page.getByRole("img", { name: /remote/i })).toBeVisible();
    await page.getByRole("button", { name: /Hide QR/i }).click();
    await page.getByRole("button", { name: /Show QR/i }).click();
    await expect(page.getByRole("img", { name: /remote/i })).toBeVisible();

    await page.locator("select").selectOption("ask");
    await expect.poll(() => JSON.stringify(state.remoteConfigUpdates)).toContain('"permission_mode":"ask"');
    await page.getByRole("button", { name: /Rotate Token/i }).click();

    await page.getByRole("button", { name: "Connect" }).nth(1).click();
    const telegramInput = page.getByPlaceholder("123456:ABC-DEF...");
    await telegramInput.fill("123456:ABC-DEF-token");
    const telegramForm = telegramInput.locator("xpath=ancestor::div[contains(@class, 'space-y-2')][1]");
    await telegramForm.getByRole("button", { name: "Connect" }).click();
    await expect.poll(() => JSON.stringify(state.channelAdds)).toContain("telegram");

    await page.getByRole("switch").first().click();
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();
    await expectNoAppCrash(page);
  });

  test("standalone and first-run workflows: routes render outside settings and onboarding routes to provider setup", async ({ page }) => {
    await setupMockedApp(page);

    await page.goto("/automations");
    await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
    await expect(page.getByText("Morning brief")).toBeVisible();

    await page.goto("/plugins");
    await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
    await expect(page.getByText("GitHub")).toBeVisible();

    await page.goto("/remote");
    await expect(page.getByRole("heading", { name: "Remote" })).toBeVisible();
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();
    await expectNoAppCrash(page);

    const onboarding = await page.context().newPage();
    await setupMockedApp(onboarding, undefined, {
      hasCompletedOnboarding: false,
    });
    await onboarding.goto("/c/new");
    await expect(onboarding.getByRole("heading", { name: "Welcome to OpenYak" })).toBeVisible();

    await onboarding.getByRole("button", { name: "Set Up Provider" }).click();
    await expect(onboarding).toHaveURL(/\/settings\?tab=providers$/);
    await expect(onboarding.getByRole("heading", { name: "Providers" })).toBeVisible();
    await expectNoAppCrash(onboarding);
    await onboarding.close();
  });
});
