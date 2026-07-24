import { expect, test } from "@playwright/test";
import {
  getStreamStatusPresentation,
  getTaskConnectionStatus,
} from "../../src/lib/stream-status";

test.describe("Stream recovery presentation", () => {
  test("keeps routine connected state silent", () => {
    expect(
      getStreamStatusPresentation({
        status: "connected",
        message: null,
      }),
    ).toBeNull();
  });

  test("exposes reconnect and provider retry progress", () => {
    expect(
      getStreamStatusPresentation({
        status: "reconnecting",
        message: "Reconnecting…",
      }),
    ).toEqual({ key: "streamReconnecting", seconds: 0 });

    expect(
      getStreamStatusPresentation({
        status: "retrying",
        message: "Retrying in 3s…",
        retry: {
          attempt: 2,
          maxRetries: 5,
          delayMs: 2_400,
          reason: "rate limit",
        },
      }),
    ).toEqual({
      key: "streamRetryingIn",
      seconds: 3,
      attempt: 2,
      maxRetries: 5,
      reason: "rate limit",
    });
  });

  test("isolates the visible task from unrelated background disconnects", () => {
    expect(getTaskConnectionStatus(undefined)).toBe("idle");
    expect(
      getTaskConnectionStatus({
        status: "reconnecting",
        message: "Reconnecting…",
      }),
    ).toBe("reconnecting");
  });
});
