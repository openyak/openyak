"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { MotionConfig } from "framer-motion";
import { ThemeProvider } from "./theme-provider";
import { QueryProvider } from "./query-provider";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { Toaster } from "sonner";
import { getBackendUrl, IS_DESKTOP } from "@/lib/constants";
import { AppearanceInjector } from "@/components/layout/appearance-injector";
import { getClientLanguagePreference } from "@/i18n/config";
import { useTranslation } from "react-i18next";

function LanguageSync({ onReady }: { onReady: () => void }) {
  const { i18n } = useTranslation();

  useEffect(() => {
    let mounted = true;
    const handler = (lng: string) => {
      document.documentElement.lang = lng;
    };
    i18n.on("languageChanged", handler);

    const preferredLanguage = getClientLanguagePreference();
    const applyLanguage = async () => {
      if (i18n.language !== preferredLanguage) {
        await i18n.changeLanguage(preferredLanguage);
      }
      if (!mounted) return;
      document.documentElement.lang = i18n.language;
      onReady();
    };
    void applyLanguage();

    return () => {
      mounted = false;
      i18n.off("languageChanged", handler);
    };
  }, [i18n, onReady]);

  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [backendReady, setBackendReady] = useState(!IS_DESKTOP);
  const [languageReady, setLanguageReady] = useState(false);
  const handleLanguageReady = useCallback(() => setLanguageReady(true), []);

  // Eagerly resolve the backend URL (important for desktop/Electron mode)
  useEffect(() => {
    let mounted = true;
    if (!IS_DESKTOP) return;
    getBackendUrl()
      .catch(() => {})
      .finally(() => {
        if (mounted) setBackendReady(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  if (!backendReady || !languageReady) {
    return <LanguageSync onReady={handleLanguageReady} />;
  }

  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <QueryProvider>
          <LanguageSync onReady={handleLanguageReady} />
          <AppearanceInjector />
          <ErrorBoundary>{children}</ErrorBoundary>
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
