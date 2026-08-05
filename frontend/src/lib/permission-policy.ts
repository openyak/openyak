import type { PermissionRequest } from "@/types/streaming";
import type { WorkMode } from "@/stores/settings-store";

/** Action-time confirmations are a hard boundary, including in Auto mode. */
export function shouldAutoApprovePermission(
  workMode: WorkMode,
  actionTime: boolean | null | undefined,
): boolean {
  return workMode === "auto" && !actionTime;
}

/** Consequential action confirmations apply once and must not persist. */
export function canRememberPermission(permission: PermissionRequest): boolean {
  return !permission.actionTime;
}
