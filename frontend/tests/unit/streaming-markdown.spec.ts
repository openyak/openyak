import { expect, test } from "@playwright/test";
import { shouldRenderCodeBlockAsSource } from "../../src/lib/streaming-markdown";

test.describe("Streaming Markdown presentation", () => {
  test("keeps an incomplete Mermaid fence as readable source while streaming", () => {
    expect(shouldRenderCodeBlockAsSource("mermaid", true)).toBe(true);
    expect(shouldRenderCodeBlockAsSource("mermaid", false)).toBe(false);
    expect(shouldRenderCodeBlockAsSource("typescript", true)).toBe(false);
  });
});
