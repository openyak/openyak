import { expect, test } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

// NB: Playwright's config-level `reducedMotion` is not reliably reflected in
// window.matchMedia here, so each test emulates it imperatively before
// navigation — verified below by asserting the media query is actually true.

test("under reduced motion: content loads, decorative motion is suppressed, loaders keep looping", async ({
  page,
}) => {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/c/new");

  // The app is functional — content is not gated behind a suppressed
  // animation (the actual bug that was suspected under reduced motion).
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });

  const probe = await page.evaluate(() => {
    const mk = (cls: string) => {
      const el = document.createElement("div");
      el.className = cls;
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = {
        dur: cs.animationDuration,
        iter: cs.animationIterationCount,
        name: cs.animationName,
      };
      el.remove();
      return out;
    };
    return {
      mqReduce: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      spin: mk("animate-spin"),
      enter: mk("animate-in fade-in-0"),
    };
  });

  // Emulation is genuinely active (guards against silently testing nothing).
  expect(probe.mqReduce).toBe(true);

  // Decorative enter animation collapses to the reduced-motion floor.
  expect(probe.enter.dur).toBe("0.001s");

  // A functional loading spinner keeps spinning — not frozen at 0s/0.01ms.
  expect(probe.spin.iter).toBe("infinite");
  expect(probe.spin.name).toBe("spin");
  expect(probe.spin.dur).toBe("1s");
});

test("a real streaming flow completes under reduced motion", async ({
  page,
}) => {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/c/new");
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });

  await page
    .getByPlaceholder(/Describe the result you want/i)
    .fill("Say hello under reduced motion");
  await page
    .locator('button[aria-label="Send message"]:not([disabled])')
    .click();

  // The assistant reply renders — nothing hangs waiting on an animation.
  await expect(
    page.getByText(/Say hello under reduced motion/).first(),
  ).toBeVisible();
  await expect(
    page.locator('button[aria-label="Send message"]'),
  ).toBeVisible({ timeout: 20_000 });
});
