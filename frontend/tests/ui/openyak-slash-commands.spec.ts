import { expect, test, type Page } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

async function openComposer(page: Page) {
  await page.goto("/c/new");
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });
  return page.getByPlaceholder(/Describe the result you want/i);
}

test.beforeEach(async ({ page }) => {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
});

test("typing / opens the command menu and Enter runs the top command", async ({
  page,
}) => {
  const composer = await openComposer(page);
  await composer.fill("/");

  const menu = page.getByRole("listbox", { name: /Commands/i });
  await expect(menu).toBeVisible();
  // Shortcuts are surfaced here — this is where they become discoverable.
  await expect(menu.getByText("New chat")).toBeVisible();
  await expect(menu.getByText("Search chats")).toBeVisible();

  // Enter runs the selected (first) command — New chat — not sends "/".
  await composer.press("Enter");
  await expect(
    page
      .getByRole("heading", {
        name: /What should (OpenYak help you do|we do in)/i,
      })
      .first(),
  ).toBeVisible();
  // "/" was consumed as a command, never sent as a message.
  await expect(composer).toHaveValue("");
});

test("/ filters, and selecting Plan mode switches the composer mode", async ({
  page,
}) => {
  const composer = await openComposer(page);
  await composer.fill("/plan");

  const menu = page.getByRole("listbox", { name: /Commands/i });
  await expect(menu.getByText("Plan first")).toBeVisible();
  await expect(menu.getByText("New chat")).toHaveCount(0);

  await menu.getByText("Plan first").click();
  // The mode pill in the action bar now reads Plan first.
  await expect(
    page.getByRole("button", { name: /Plan first/i }).first(),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
});

test("a slash mid-sentence is NOT treated as a command", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.fill("summarize docs/plan and the q3 report");
  await expect(page.getByRole("listbox", { name: /Commands/i })).toHaveCount(0);
  // Enter with a normal message sends it (the menu never hijacked Enter).
  const prompt = page.waitForResponse(
    (r) => r.url().includes("/api/chat/prompt") && r.status() === 200,
  );
  await composer.press("Enter");
  await prompt;
});

test("Escape closes the command menu and keeps the typed text", async ({
  page,
}) => {
  const composer = await openComposer(page);
  await composer.fill("/sea");
  await expect(page.getByRole("listbox", { name: /Commands/i })).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByRole("listbox", { name: /Commands/i })).toHaveCount(0);
  await expect(composer).toHaveValue("/sea");
});
