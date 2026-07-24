import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test.describe("Streaming presentation contract", () => {
  test("the caret never changes the display mode of streamed Markdown blocks", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );

    expect(css).not.toMatch(
      /\.streaming-cursor\s*>\s*\*:last-child\s*\{[^}]*display:\s*inline/im,
    );
    expect(css).toMatch(
      /\.streaming-cursor\s*>\s*:last-child::after\s*\{/,
    );
  });

  test("auto-follow observes text-node growth as well as inserted blocks", () => {
    const hook = readFileSync(
      resolve(process.cwd(), "src/hooks/use-scroll-anchor.ts"),
      "utf8",
    );

    expect(hook).toMatch(/characterData:\s*true/);
  });
});
