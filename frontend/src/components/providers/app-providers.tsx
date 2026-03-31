"use client";

import { type ReactNode, useEffect, useState } from "react";
import { MotionConfig } from "framer-motion";
import { ThemeProvider } from "./theme-provider";
import { QueryProvider } from "./query-provider";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { Toaster } from "sonner";
import { getBackendUrl, IS_DESKTOP } from "@/lib/constants";
import "@/i18n/config";
import { useTranslation } from "react-i18next";

function LanguageSync() {
  const { i18n } = useTranslation();

  useEffect(() => {
    document.documentElement.lang = i18n.language;
    const handler = (lng: string) => {
      document.documentElement.lang = lng;
    };
    i18n.on("languageChanged", handler);
    return () => {
      i18n.off("languageChanged", handler);
    };
  }, [i18n]);

  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!IS_DESKTOP);

  // Eagerly resolve the backend URL (important for desktop/Electron mode)
  useEffect(() => {
    let mounted = true;
    if (!IS_DESKTOP) return;
    getBackendUrl()
      .catch(() => {})
      .finally(() => {
        if (mounted) setReady(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  if (!ready) return null;

  return (
    <MotionConfig reducedMotion="user">
    <ThemeProvider>
      <QueryProvider>
        <LanguageSync />
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
        <Toaster
          position="top-right"
          richColors
          closeButton
          toastOptions={{
            style: {
              background: "var(--surface-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-default)",
            },
          }}
        />
      </QueryProvider>
    </ThemeProvider>
    </MotionConfig>
  );
}
