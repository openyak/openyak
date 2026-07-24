import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

test.describe("OpenYak Work mode task shell", () => {
  test.describe.configure({ timeout: 60_000 });
  test.skip(
    ({ isMobile }) => isMobile,
    "The desktop task shell has a persistent header, transcript, and composer.",
  );

  test.beforeEach(async ({ page }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);
  });

  test("keeps task identity in the header and execution controls in the composer", async ({
    page,
  }) => {
    await page.goto("/c/session-alpha");

    const taskHeader = page.getByRole("banner");
    await expect(taskHeader.getByText("Quarterly planning notes")).toBeVisible();

    const composer = page.getByRole("region", {
      name: "Message composer",
    });
    await expect(
      composer.getByRole("button", { name: "Claude Sonnet 4.5" }),
    ).toBeVisible();
    await expect(
      composer.getByRole("button", { name: "Auto-edit", exact: true }),
    ).toBeVisible();
    await expect(
      composer.getByRole("button", { name: /^Ultra:/ }),
    ).toBeVisible();

    await expect(
      taskHeader.getByRole("button", { name: "Claude Sonnet 4.5" }),
    ).toHaveCount(0);
  });

  test("wide Work Mode keeps the transcript centered under an overlay summary", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1936, height: 1192 });
    await page.goto("/c/session-alpha");

    const main = page.locator("#main-content");
    await expect
      .poll(() => main.evaluate((element) => getComputedStyle(element).marginRight))
      .toBe("0px");

    const composerSurface = page
      .getByRole("region", { name: "Message composer" })
      .locator("div.rounded-3xl")
      .first();
    const composerBox = await composerSurface.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.width).toBeLessThanOrEqual(738);
    expect(composerBox!.x).toBeGreaterThan(700);
    expect(composerBox!.height).toBeLessThanOrEqual(110);
    expect(
      await composerSurface.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).toBe("rgb(45, 45, 45)");
    expect(1192 - (composerBox!.y + composerBox!.height)).toBeGreaterThanOrEqual(
      20,
    );

    await expect(
      page.getByRole("button", { name: "Hide workspace" }),
    ).toBeVisible();
  });

  test("compact desktop pins the summary without covering the composer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1399, height: 733 });
    await page.goto("/c/session-alpha");

    const main = page.locator("#main-content");
    await expect
      .poll(() => main.evaluate((element) => getComputedStyle(element).marginRight))
      .toBe("320px");

    const composerSurface = page
      .getByRole("region", { name: "Message composer" })
      .locator("div.rounded-3xl")
      .first();
    const composerBox = await composerSurface.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(1079);
  });

  test("uses the real post-sidebar width before overlaying Summary", async ({
    page,
  }) => {
    const cases = [
      { viewport: 1024, sidebar: 300, overlay: false },
      { viewport: 1280, sidebar: 240, overlay: false },
      { viewport: 1599, sidebar: 240, overlay: false },
      { viewport: 1600, sidebar: 300, overlay: false },
      { viewport: 1676, sidebar: 240, overlay: true },
      { viewport: 1856, sidebar: 480, overlay: false },
      { viewport: 1936, sidebar: 480, overlay: true },
    ];

    await page.goto("/");
    for (const current of cases) {
      await page.setViewportSize({
        width: current.viewport,
        height: 900,
      });
      await page.evaluate((sidebarWidth) => {
        window.localStorage.setItem(
          "openyak-sidebar",
          JSON.stringify({
            state: {
              collapsedProjects: {},
              organizeMode: "by-project",
              sortBy: "updated",
              width: sidebarWidth,
            },
            version: 0,
          }),
        );
      }, current.sidebar);
      await page.goto("/c/session-alpha");

      const main = page.locator("#main-content");
      await expect
        .poll(() =>
          main.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).marginRight),
          ),
        )
        .toBe(current.overlay ? 0 : 320);

      const summaryBox = await page
        .getByRole("complementary", { name: "Task summary" })
        .boundingBox();
      const composerSurface = page
        .getByRole("region", { name: "Message composer" })
        .locator("div.rounded-3xl")
        .first();
      const composerBox = await composerSurface.boundingBox();
      const sendBox = await page
        .getByRole("button", { name: /Send message/i })
        .boundingBox();

      expect(summaryBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      expect(composerBox!.x + composerBox!.width)
        .toBeLessThanOrEqual(summaryBox!.x);
      expect(sendBox!.x + sendBox!.width)
        .toBeLessThanOrEqual(composerBox!.x + composerBox!.width);
      expect(sendBox!.y + sendBox!.height)
        .toBeLessThanOrEqual(composerBox!.y + composerBox!.height);
    }
  });
});
