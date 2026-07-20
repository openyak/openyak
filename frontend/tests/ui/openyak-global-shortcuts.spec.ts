import { expect, test, type Page } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test.beforeEach(async ({ page }) => {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
});

async function openChat(page: Page) {
  await page.goto("/c/new");
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Sidebar width is animated; read the rendered box instead of a class. */
async function sidebarWidth(page: Page): Promise<number> {
  const box = await page
    .getByRole("complementary", { name: "Chat sidebar" })
    .boundingBox();
  return box?.width ?? 0;
}

test("Cmd+B toggles the sidebar, and works while typing in the composer", async ({
  page,
}) => {
  await openChat(page);
  expect(await sidebarWidth(page)).toBeGreaterThan(100);

  await page.keyboard.press("ControlOrMeta+b");
  await expect.poll(() => sidebarWidth(page)).toBeLessThan(10);

  await page.keyboard.press("ControlOrMeta+b");
  await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(100);

  // Deliberate: the sidebar toggle stays live mid-draft, and must not eat
  // the composer text.
  const composer = page.getByPlaceholder(/Describe the result you want/i);
  await composer.fill("draft in progress");
  await composer.press("ControlOrMeta+b");
  await expect.poll(() => sidebarWidth(page)).toBeLessThan(10);
  await expect(composer).toHaveValue("draft in progress");
  await page.keyboard.press("ControlOrMeta+b");
});

test("Cmd+N starts a new chat but never fires while typing", async ({
  page,
}) => {
  await page.goto("/c/session-artifacts");
  await expect(page.getByText("Artifact showcase").first()).toBeVisible({
    timeout: 15_000,
  });

  await page.keyboard.press("ControlOrMeta+n");
  await expect(
    page
      .getByRole("heading", {
        name: /What should (OpenYak help you do|we do in)/i,
      })
      .first(),
  ).toBeVisible();

  // Typing "n" with the modifier inside the composer must not navigate away
  // and lose the draft.
  const composer = page.getByPlaceholder(/Describe the result you want/i);
  await composer.fill("keep me");
  await composer.press("ControlOrMeta+n");
  await expect(composer).toHaveValue("keep me");
});

test("Cmd+Shift+] and Cmd+Shift+[ cycle through conversations", async ({
  page,
}) => {
  await openChat(page);

  await page.keyboard.press("ControlOrMeta+Shift+]");
  await expect.poll(() => page.url()).toMatch(/\/c\/(?!new)/);
  const first = page.url();

  await page.keyboard.press("ControlOrMeta+Shift+]");
  await expect.poll(() => page.url()).not.toBe(first);
  const second = page.url();

  // Stepping back returns to the previous conversation.
  await page.keyboard.press("ControlOrMeta+Shift+[");
  await expect.poll(() => page.url()).toBe(first);
  expect(second).not.toBe(first);
});

test("Cmd+, opens settings", async ({ page }) => {
  await openChat(page);
  await page.keyboard.press("ControlOrMeta+,");
  await expect.poll(() => page.url()).toContain("/settings");
});
