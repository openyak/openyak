/**
 * Next.js instrumentation hook — runs once on server startup.
 *
 * Suppresses the spurious "unrecognized HMR message" unhandledRejection
 * that Turbopack emits on ping heartbeats (Next.js known issue).
 */
export function register() {
  if (process.env.NODE_ENV === "development" && typeof process.on === "function") {
    process.on("unhandledRejection", (reason) => {
      if (
        reason instanceof Error &&
        reason.message.includes("unrecognized HMR message")
      ) {
        // Swallow — this is a Turbopack bug, not an app error.
        return;
      }
      // Let everything else through to the default handler.
      console.error("unhandledRejection:", reason);
    });
  }
}
