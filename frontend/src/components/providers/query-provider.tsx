"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { setStreamRegistryQueryClient } from "@/lib/session-stream-registry";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60_000,
          gcTime: 5 * 60 * 1000,
          retry: 1,
          refetchOnWindowFocus: false,
          structuralSharing: true,
        },
      },
    });
    // The session stream registry runs outside React but uses React Query
    // for cache invalidation. It needs the same client instance the rest of
    // the app subscribes to.
    setStreamRegistryQueryClient(qc);
    return qc;
  });

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
