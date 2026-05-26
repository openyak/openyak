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

let permissionRequestInFlight: Promise<NotificationPermission> | null = null;

function getRoute(sessionId: string): string {
  return `/c/${sessionId}`;
}

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
        if (typeof window !== "undefined") {
          // history.pushState avoids a full reload — Next.js App Router picks
          // it up via the popstate listener and renders the chat in place.
          window.location.assign(getRoute(sessionId));
        }
      } finally {
        n.close();
      }
    };
  } catch {
    // Notifications can throw if the browser blocks them post-grant
    // (e.g. user revoked, or quota exceeded). Best-effort.
  }
}
