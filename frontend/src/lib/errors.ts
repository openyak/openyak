/**
 * Error message extraction utilities.
 *
 * Centralised so every UI surface that renders backend errors handles the same
 * input shapes the same way. Prevents the React-child-crash class of bug where
 * an array-form FastAPI 422 detail is dropped into JSX as-is.
 */

/**
 * Coerce an arbitrary error response body into a user-readable string.
 *
 * Handled shapes:
 *   - `string`                                          → returned (clipped to 300 chars to survive 502 HTML or rate-limit text dumps)
 *   - `{ detail: string }`                              → returns the detail
 *   - `{ detail: [{msg: string, ...}, ...] }` (FastAPI) → joins all `msg` fields with "; "
 *   - `{ detail: ["str1", "str2"] }`                    → joins items with "; "
 *   - `{ message: string }`                             → returns the message
 *   - anything else                                     → returns `fallback`
 *
 * Always returns a string. Never throws.
 */
export function extractErrorMessage(body: unknown, fallback: string): string {
  // Non-JSON proxy responses (Cloudflare 502 HTML, plain-text rate-limit) come
  // through as raw strings — surface them rather than swallowing into fallback.
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed) return trimmed.slice(0, 300);
    return fallback;
  }

  if (!body || typeof body !== "object") return fallback;

  if ("detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const messages: string[] = [];
      for (const item of detail) {
        if (typeof item === "string") {
          messages.push(item);
        } else if (item && typeof item === "object" && "msg" in item) {
          const msg = (item as { msg: unknown }).msg;
          if (typeof msg === "string") messages.push(msg);
        }
      }
      if (messages.length > 0) return messages.join("; ").slice(0, 300);
    }
  }

  if ("message" in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }

  return fallback;
}

/**
 * Extract a user-readable message from any error. Walks ApiError-shaped and
 * ProxyApiError-shaped objects (anything with `.body: unknown`), then falls
 * back to `Error.message`, then to the supplied `fallback`.
 */
export function errorToMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "body" in err) {
    const detail = extractErrorMessage((err as { body: unknown }).body, "");
    if (detail) return detail;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
