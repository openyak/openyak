import { expect, test } from "@playwright/test";
import {
  canRememberPermission,
  shouldAutoApprovePermission,
} from "@/lib/permission-policy";
import type { PermissionRequest } from "@/types/streaming";


const request = (actionTime: boolean): PermissionRequest => ({
  callId: "permission-1",
  tool: "browser",
  permission: "browser.sensitive_action",
  patterns: ["https://example.test"],
  arguments: {},
  actionTime,
});


test("Auto mode never bypasses an action-time Computer Use confirmation", () => {
  expect(shouldAutoApprovePermission("auto", false)).toBe(true);
  expect(shouldAutoApprovePermission("auto", true)).toBe(false);
  expect(shouldAutoApprovePermission("ask", false)).toBe(false);
});


test("action-time confirmation decisions cannot be remembered", () => {
  expect(canRememberPermission(request(false))).toBe(true);
  expect(canRememberPermission(request(true))).toBe(false);
});
