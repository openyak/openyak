const IS_DESKTOP_BUILD = process.env.NEXT_PUBLIC_DESKTOP_BUILD === "true";

export function getChatRoute(sessionId?: string | null): string {
  if (!sessionId) return "/c/new";
  return IS_DESKTOP_BUILD
    ? `/c/_?sessionId=${encodeURIComponent(sessionId)}`
    : `/c/${sessionId}`;
}

/**
 * Canonical parent-task Work view for persisted child-Agent runs.
 *
 * Keeping this state on the parent chat URL lets the task shell retain its
 * mounted transcript, composer, and workspace while the Work view is open.
 */
export function getTaskSubagentsRoute(
  parentSessionId: string,
  childSessionId?: string | null,
): string {
  const parentRoute = getChatRoute(parentSessionId);
  const separator = parentRoute.includes("?") ? "&" : "?";
  const params = new URLSearchParams({ view: "subagents" });
  if (childSessionId) {
    params.set("child", childSessionId);
  }
  return `${parentRoute}${separator}${params.toString()}`;
}

export function resolveSessionId(
  pathSessionId?: string | null,
  querySessionId?: string | null,
): string | null {
  if (!pathSessionId) return querySessionId ?? null;
  if (pathSessionId === "_") return querySessionId ?? null;
  return pathSessionId;
}
