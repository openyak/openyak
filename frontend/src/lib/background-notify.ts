"use client";

/**
 * Fire a native notification when a session finishes in the background.
 *
 * Uses the web Notification API (works in Tauri webview, mobile browser,
 * and desktop Chrome alike — no Rust plugin needed). Permission is
 * requested lazily on the first background completion so users never see
 * the prompt for foreground-only usage.
 *
 * The caller is responsible for deciding whether the session was actually
 * "in the background" — this helper does not check focus state.
 */

/**
 * Custom event the registry dispatches when a notification is clicked.
 * A top-level component (currently `StreamRegistryHydration`) listens for
 * it and routes via the Next.js router so we do soft navigation instead of
 * a full reload (which would tear down the in-memory stream registry).
 */
export const NAVIGATE_TO_SESSION_EVENT = "openyak:navigate-to-session";

export interface NavigateToSessionDetail {
  sessionId: string;
}

let permissionRequestInFlight: Promise<NotificationPermission> | null = null;

async function ensurePermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  if (!permissionRequestInFlight) {
    permissionRequestInFlight = Notification.requestPermission().finally(() => {
      permissionRequestInFlight = null;
    });
  }
  return permissionRequestInFlight;
}

interface NotifyOptions {
  sessionId: string;
  title: string;
  body: string;
  /** "done" | "error" — used for the tag so a later update replaces, not stacks. */
  kind: "done" | "error";
}

export async function notifyBackgroundFinish({ sessionId, title, body, kind }: NotifyOptions): Promise<void> {
  const perm = await ensurePermission();
  if (perm !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      tag: `openyak-${kind}-${sessionId}`,
    });
    n.onclick = () => {
      try {
        window.focus();
        window.dispatchEvent(
          new CustomEvent<NavigateToSessionDetail>(NAVIGATE_TO_SESSION_EVENT, {
            detail: { sessionId },
          }),
        );
      } finally {
        n.close();
      }
    };
  } catch {
    // Notifications can throw if the browser blocks them post-grant
    // (e.g. user revoked, or quota exceeded). Best-effort.
  }
}
