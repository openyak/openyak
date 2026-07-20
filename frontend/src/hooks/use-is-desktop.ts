"use client";

import { useEffect, useState } from "react";

/**
 * Desktop-breakpoint media query (lg, 1024px) — shared by the layout and the
 * right-hand panels so they agree on when the task panel replaces the mobile
 * sheets. Starts false to avoid hydration mismatch.
 */
export function useIsDesktop() {
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
