"use client";

import { useEffect, useRef, type RefObject } from "react";

const SCROLLBAR_IDLE_MS = 1500;

export function useScrollbarActivity<T extends HTMLElement>(ref: RefObject<T | null>) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const attachedElRef = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (attachedElRef.current === el) return;

    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    attachedElRef.current = el;
    if (!el) return;

    let idleTimeoutId = 0;

    const showScrollbar = () => {
      el.classList.add("scrolling");
      clearTimeout(idleTimeoutId);
      idleTimeoutId = window.setTimeout(() => {
        el.classList.remove("scrolling");
      }, SCROLLBAR_IDLE_MS);
    };

    el.addEventListener("wheel", showScrollbar, { passive: true });
    el.addEventListener("scroll", showScrollbar, { passive: true });
    el.addEventListener("touchmove", showScrollbar, { passive: true });

    cleanupRef.current = () => {
      el.removeEventListener("wheel", showScrollbar);
      el.removeEventListener("scroll", showScrollbar);
      el.removeEventListener("touchmove", showScrollbar);
      clearTimeout(idleTimeoutId);
      el.classList.remove("scrolling");
    };
  });

  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      attachedElRef.current = null;
    };
  }, []);
}
