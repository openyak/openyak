import { Suspense } from "react";
import { SessionPageClient } from "./session-page-client";

/**
 * Required for Next.js static export — dynamic routes need this.
 * Returning at least one entry prevents Next.js from failing to detect the function.
 * Actual sessions are resolved client-side via useParams in the Electron app.
 */
export async function generateStaticParams() {
  return [{ sessionId: "_" }];
}

export default async function SessionPage() {
  return (
    <Suspense fallback={null}>
      <SessionPageClient />
    </Suspense>
  );
}
