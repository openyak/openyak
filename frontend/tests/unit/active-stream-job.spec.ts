import { expect, test } from "@playwright/test";
import {
  isChildStreamJob,
  shouldHydrateStreamJob,
} from "../../src/lib/active-stream-job";

test.describe("Active stream job routing", () => {
  test("hydrates root tasks globally but attaches child tasks on demand", () => {
    const root = {
      stream_id: "root-stream",
      session_id: "root-session",
      needs_input: false,
    };
    const child = {
      stream_id: "child-stream",
      session_id: "child-session",
      parent_session_id: "root-session",
      needs_input: false,
    };

    expect(shouldHydrateStreamJob(root)).toBe(true);
    expect(isChildStreamJob(root)).toBe(false);
    expect(shouldHydrateStreamJob(child)).toBe(false);
    expect(isChildStreamJob(child)).toBe(true);
  });
});
