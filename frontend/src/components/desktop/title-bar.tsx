"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Minus, Square, X, Copy, Plus } from "lucide-react";
import { IS_DESKTOP, TITLE_BAR_HEIGHT } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";

/** OpenYak logo rendered at title bar size. */
function OpenYakLogo() {
  return (
    <img
      src="/favicon.svg"
      width={18}
      height={18}
      alt="OpenYak"
      className="shrink-0"
    />
  );
}

/**
 * Custom title bar for desktop mode (Tauri).
 *
 * - Renders only when running inside a desktop shell
 * - Shows app logo + name on the left
 * - Provides a draggable region and window control buttons
 * - On macOS, we render custom traffic-light controls because
 *   window decorations are disabled for a unified app chrome
 */
export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [platform, setPlatform] = useState<string>("windows");
  const pathname = usePathname();

  useEffect(() => {
    if (!IS_DESKTOP) return;

    let cleanup: (() => void) | undefined;
    desktopAPI.getPlatform().then((os) => {
      setPlatform(os);
      // macOS uses native traffic lights, so maximize state is not used by UI.
      // Skip listener wiring to avoid unnecessary IPC/event traffic.
      if (os === "macos") return;
      desktopAPI.isMaximized().then(setIsMaximized);
      cleanup = desktopAPI.onMaximizeChange(setIsMaximized);
    });

    return () => cleanup?.();
  }, []);

  if (!IS_DESKTOP) return null;

  const isMac = platform === "macos";
  const sectionTitle = getSectionTitle(pathname ?? "");

  if (isMac) {
    // macOS: native traffic lights via titleBarStyle="overlay".
    // We only render a transparent draggable bar for the title text.
    return (
      <div
        data-tauri-drag-region
        className="fixed top-0 left-0 right-0 z-50 flex items-center select-none pointer-events-none"
        style={{
          height: TITLE_BAR_HEIGHT,
        }}
      >
        {/* Spacer for native traffic lights area */}
        <div className="w-[78px] shrink-0" />

        {/* Centered title */}
        <div
          data-tauri-drag-region
          className="flex-1 h-full flex items-center justify-center"
        >
          <span className="text-xs font-medium tracking-wide text-[var(--text-secondary)]">
            {sectionTitle}
          </span>
        </div>

        {/* Symmetric spacer */}
        <div className="w-[78px] shrink-0" />
      </div>
    );
  }

  return (
    <div
      data-tauri-drag-region
      className="fixed top-0 left-0 right-0 z-50 flex items-center select-none"
      style={{
        height: TITLE_BAR_HEIGHT,
        backgroundColor: "var(--surface-primary)",
        borderBottom: "1px solid var(--border-primary)",
      }}
    >
      {/* Logo + App name */}
      <div
        className="flex items-center gap-2 pl-3 h-full shrink-0"
        style={{ paddingLeft: isMac ? 78 : 12 }}
      >
        <OpenYakLogo />
        <span className="text-xs font-medium text-[var(--text-secondary)] tracking-wide">
          OpenYak
        </span>
      </div>

      {/* Spacer — draggable area */}
      <div data-tauri-drag-region className="flex-1 h-full" />

      {/* Windows/Linux: custom window controls */}
      <div className="flex items-center h-full shrink-0">
        <button
          onClick={() => desktopAPI.minimize()}
          className="inline-flex items-center justify-center w-[46px] h-full
                     text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]
                     transition-colors"
          aria-label="Minimize"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          onClick={() => desktopAPI.maximize()}
          className="inline-flex items-center justify-center w-[46px] h-full
                     text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]
                     transition-colors"
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <Copy className="h-3.5 w-3.5" />
          ) : (
            <Square className="h-3 w-3" />
          )}
        </button>
        <button
          onClick={() => desktopAPI.close()}
          className="inline-flex items-center justify-center w-[46px] h-full
                     text-[var(--text-secondary)] hover:bg-red-600 hover:text-white
                     transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function getSectionTitle(pathname: string): string {
  if (pathname.startsWith("/settings")) return "OpenYak - Settings";
  if (pathname.startsWith("/billing")) return "OpenYak - Billing";
  if (pathname.startsWith("/usage")) return "OpenYak - Usage";
  if (pathname.startsWith("/c/new")) return "OpenYak - New Chat";
  if (pathname.startsWith("/c/")) return "OpenYak - Chat";
  return "OpenYak";
}
