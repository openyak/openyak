"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { SquarePen } from "lucide-react";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ActivityPanel } from "@/components/activity/activity-panel";
import { ArtifactPanel } from "@/components/artifacts/artifact-panel";
import { PlanReviewPanel } from "@/components/plan-review/plan-review-panel";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { usePlanReviewStore } from "@/stores/plan-review-store";
import { ConnectionStatus } from "@/components/layout/connection-status";
import { RouteProgressBar } from "@/components/layout/route-progress-bar";
import { SplashScreen } from "@/components/layout/splash-screen";
import { TitleBar } from "@/components/desktop/title-bar";
import { UpdateBanner } from "@/components/desktop/update-banner";
import { UpgradePrompt } from "@/components/billing/upgrade-prompt";
import { OnboardingScreen } from "@/components/onboarding/onboarding-screen";
import { Button } from "@/components/ui/button";
import { OpenYakLogo } from "@/components/ui/openyak-logo";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useSettingsStore, useSettingsHasHydrated } from "@/stores/settings-store";
import { useAuthStore, useAuthHasHydrated } from "@/stores/auth-store";
import { useAutoDetectProvider } from "@/hooks/use-auto-detect-provider";
import { useActivityStore } from "@/stores/activity-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { api } from "@/lib/api";
import {
  API,
  SIDEBAR_WIDTH,
  ACTIVITY_PANEL_WIDTH,
  WORKSPACE_PANEL_WIDTH,
  IS_DESKTOP,
  TITLE_BAR_HEIGHT,
  queryKeys,
} from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";
import { useTranslation } from "react-i18next";

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const pathname = usePathname();
  const isCollapsed = useSidebarStore((s) => s.isCollapsed);
  const toggleSidebar = useSidebarStore((s) => s.toggle);
  const activityIsOpen = useActivityStore((s) => s.isOpen);
  const artifactIsOpen = useArtifactStore((s) => s.isOpen);
  const artifactWidth = useArtifactStore((s) => s.panelWidth);
  const planReviewIsOpen = usePlanReviewStore((s) => s.isOpen);
  const planReviewWidth = usePlanReviewStore((s) => s.panelWidth);
  const isDesktop = useIsDesktop();
  const qc = useQueryClient();
  useAutoDetectProvider();

  const authHydrated = useAuthHasHydrated();
  const settingsHydrated = useSettingsHasHydrated();

  // Onboarding gate — show onboarding if first run and not already connected
  const hasCompletedOnboarding = useSettingsStore((s) => s.hasCompletedOnboarding);
  const isConnected = useAuthStore((s) => s.isConnected);
  const proxyUrl = useAuthStore((s) => s.proxyUrl);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  // Client-side only check for desktop mode (prevents hydration mismatch)
  const [showSplash, setShowSplash] = useState(false);
  useEffect(() => {
    setShowSplash(IS_DESKTOP);
    if (authHydrated && settingsHydrated) {
      setNeedsOnboarding(!hasCompletedOnboarding && !isConnected);
    }
  }, [hasCompletedOnboarding, isConnected, authHydrated, settingsHydrated]);

  useEffect(() => {
    if (!IS_DESKTOP || !isConnected || !proxyUrl || !accessToken) return;

    let cancelled = false;

    const syncOpenYakAccount = async () => {
      try {
        const status = await api.get<{ is_connected: boolean; proxy_url: string }>(API.CONFIG.OPENYAK_ACCOUNT);
        if (!cancelled && status.is_connected && status.proxy_url === proxyUrl) {
          return;
        }
      } catch {
        // Fall through to re-sync the desktop backend.
      }

      try {
        await api.post(API.CONFIG.OPENYAK_ACCOUNT, {
          proxy_url: proxyUrl,
          token: accessToken,
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
        });
        if (!cancelled) {
          qc.invalidateQueries({ queryKey: queryKeys.models });
          qc.invalidateQueries({ queryKey: queryKeys.openyakAccount });
        }
      } catch {
        // Expected when proxy is unreachable or token is expired — non-critical.
      }
    };

    void syncOpenYakAccount();

    return () => {
      cancelled = true;
    };
  }, [isConnected, proxyUrl, accessToken, refreshToken, qc]);

  useEffect(() => {
    if (!IS_DESKTOP) return;

    let cancelled = false;

    void desktopAPI.getPendingNavigation().then((path) => {
      if (!cancelled && path) {
        router.push(path);
      }
    });

    const cleanup = desktopAPI.onNavigate((path) => {
      router.push(path);
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [router]);

  // Intercept clicks on external links and open them in the system browser
  // instead of navigating the Tauri webview (which blocks external URLs).
  useEffect(() => {
    if (!IS_DESKTOP) return;

    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest("a[href]");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      // Only intercept absolute external URLs (http/https)
      if (!/^https?:\/\//i.test(href)) return;

      e.preventDefault();
      e.stopPropagation();
      desktopAPI.openExternal(href);
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);

  // Close overlay panels on page navigation
  const closeActivity = useActivityStore((s) => s.close);
  const closeArtifact = useArtifactStore((s) => s.close);
  const closePlanReview = usePlanReviewStore((s) => s.close);
  useEffect(() => {
    closeActivity();
    closeArtifact();
    closePlanReview();
  }, [pathname, closeActivity, closeArtifact, closePlanReview]);

  const marginLeft = isDesktop && !isCollapsed ? SIDEBAR_WIDTH : 0;
  const isChatPage = pathname?.startsWith("/c/") ?? false;
  const isActiveChat = isChatPage && pathname !== "/c/new";
  const showWorkspace = isDesktop && isActiveChat;
  const overlayWidth = artifactIsOpen
    ? artifactWidth
    : planReviewIsOpen
      ? planReviewWidth
      : activityIsOpen
        ? ACTIVITY_PANEL_WIDTH
        : 0;
  const marginRight = isDesktop
    ? Math.max(showWorkspace ? WORKSPACE_PANEL_WIDTH : 0, overlayWidth)
    : 0;

  // Add top padding when the desktop title bar is active
  const titleBarPadding = IS_DESKTOP ? TITLE_BAR_HEIGHT : 0;

  return (
    <div className="h-full overflow-hidden">
      {/* Skip link for keyboard navigation */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[var(--surface-primary)] focus:text-[var(--text-primary)] focus:border focus:border-[var(--border-default)] focus:shadow-[var(--shadow-md)] focus:text-sm focus:font-medium"
      >
        Skip to main content
      </a>

      {/* Splash screen for desktop app initialization */}
      {showSplash && <SplashScreen />}

      {/* Onboarding flow for first-run users */}
      {needsOnboarding && <OnboardingScreen />}

      {/* Top progress bar for route transitions */}
      <RouteProgressBar />

      {/* Desktop title bar (Electron only) */}
      <TitleBar />

      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile nav drawer */}
      <MobileNav />

      {/* Collapsed quick actions for non-chat pages */}
      {isDesktop && isCollapsed && !isChatPage && (
        <TooltipProvider delayDuration={200}>
          <div
            className="fixed left-3 z-40 flex items-center gap-1 rounded-xl bg-[var(--surface-primary)]/80 backdrop-blur-sm px-1 py-0.5"
            style={{ top: titleBarPadding + 8 }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  onClick={toggleSidebar}
                  aria-label={t("openSidebar")}
                >
                  <OpenYakLogo size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("openSidebar")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  asChild
                  aria-label={t("newChat")}
                >
                  <Link href="/c/new">
                    <SquarePen className="h-[18px] w-[18px]" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("newChat")}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      )}

      {/* Main content area */}
      <motion.main
        id="main-content"
        tabIndex={-1}
        className="h-full flex flex-col outline-none"
        style={{
          paddingTop: titleBarPadding,
          marginLeft,
          marginRight,
        }}
        initial={false}
        animate={{
          marginLeft,
          marginRight
        }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
      >
        <ConnectionStatus />
        <UpdateBanner />
        {children}
      </motion.main>

      {/* Workspace panel — only on active chat sessions */}
      {showWorkspace && <WorkspacePanel />}

      {/* Overlay panels (mutually exclusive, z-35) - cover workspace when open */}
      <AnimatePresence mode="wait">
        {activityIsOpen && <ActivityPanel key="activity" />}
        {artifactIsOpen && <ArtifactPanel key="artifact" />}
        {planReviewIsOpen && <PlanReviewPanel key="plan-review" />}
      </AnimatePresence>

      {/* Upgrade prompt dialog */}
      <UpgradePrompt />
    </div>
  );
}
