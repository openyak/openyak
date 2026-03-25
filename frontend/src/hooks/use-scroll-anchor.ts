"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Auto-scroll to bottom of a container when new content is added,
 * unless the user has explicitly scrolled up.
 *
 * Uses wheel/touch events to detect intentional user scrolling (rather than
 * relying on scroll-position checks, which are fooled by content growth
 * during streaming).
 *
 * Uses a ref callback instead of RAF polling to detect when the scroll
 * container DOM element changes (e.g. conditional rendering swaps).
 */
export function useScrollAnchor() {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  /** True when the user has intentionally scrolled away from the bottom. */
  const userScrolledRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** The currently attached element (for scrollToBottom). */
  const currentElRef = useRef<HTMLDivElement | null>(null);
  /** Mirror of isAtBottom to avoid redundant setState calls. */
  const isAtBottomRef = useRef(true);

  // Helper: only update React state when the value actually changes
  const updateIsAtBottom = useCallback((value: boolean) => {
    if (isAtBottomRef.current !== value) {
      isAtBottomRef.current = value;
      setIsAtBottom(value);
    }
  }, []);

  // Attach event listeners and MutationObserver to an element
  const attachTo = useCallback((el: HTMLDivElement) => {
    // Cleanup previous
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    currentElRef.current = el;

    /** Check if the element is scrolled to the bottom (or has no overflow). */
    const checkAtBottom = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      return scrollHeight <= clientHeight || scrollHeight - scrollTop - clientHeight < 50;
    };

    // Immediately sync isAtBottom for the new element
    const initial = checkAtBottom();
    isAtBottomRef.current = initial;
    setIsAtBottom(initial);

    // --- wheel (desktop) ---
    let idleTimeoutId = 0;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrolledRef.current = true;
      }
      // Show scrollbar on wheel event
      el.classList.add("scrolling");
      clearTimeout(idleTimeoutId);
      // Hide after 1.5s of inactivity
      idleTimeoutId = window.setTimeout(() => {
        el.classList.remove("scrolling");
      }, 1500);
    };

    // --- touch (mobile) ---
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches[0].clientY > touchStartY) {
        userScrolledRef.current = true;
      }
    };

    // --- scroll position (for button visibility + re-enable auto-scroll) ---
    // Throttled via rAF to fire at most once per frame.
    // Only re-engage auto-scroll when the user actively scrolls DOWN to the
    // bottom — prevents small upward scrolls from being "bounced back" by the
    // MutationObserver auto-scroll.
    let scrollRafId = 0;
    let lastScrollTop = el.scrollTop;
    let scrollIdleTimeoutId = 0;
    const handleScroll = () => {
      if (scrollRafId) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        const currentScrollTop = el.scrollTop;
        const scrolledDown = currentScrollTop > lastScrollTop;
        lastScrollTop = currentScrollTop;

        // Show scrollbar on scroll activity
        el.classList.add("scrolling");
        clearTimeout(scrollIdleTimeoutId);
        // Hide after 1.5s of inactivity
        scrollIdleTimeoutId = window.setTimeout(() => {
          el.classList.remove("scrolling");
        }, 1500);

        const atBottom = checkAtBottom();
        updateIsAtBottom(atBottom);
        if (atBottom && scrolledDown && userScrolledRef.current) {
          userScrolledRef.current = false;
        }
      });
    };

    el.addEventListener("wheel", handleWheel, { passive: true });
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    el.addEventListener("scroll", handleScroll, { passive: true });

    // --- MutationObserver for auto-scroll on content changes ---
    // Do NOT observe characterData: streaming text changes every character and would
    // fire hundreds of times/sec, causing 100%+ CPU and UI freeze on M1.
    let mutationRafId = 0;
    let mutationLastRun = 0;
    const MUTATION_THROTTLE_MS = 80;
    const observer = new MutationObserver(() => {
      if (userScrolledRef.current) {
        if (!mutationRafId) {
          mutationRafId = requestAnimationFrame(() => {
            mutationRafId = 0;
            updateIsAtBottom(false);
          });
        }
        return;
      }
      const now = performance.now();
      if (now - mutationLastRun < MUTATION_THROTTLE_MS) {
        if (!mutationRafId) {
          mutationRafId = requestAnimationFrame(() => {
            mutationRafId = 0;
            mutationLastRun = performance.now();
            el.scrollTop = el.scrollHeight;
            updateIsAtBottom(checkAtBottom());
          });
        }
        return;
      }
      mutationLastRun = now;
      if (!mutationRafId) {
        mutationRafId = requestAnimationFrame(() => {
          mutationRafId = 0;
          el.scrollTop = el.scrollHeight;
          updateIsAtBottom(checkAtBottom());
        });
      }
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      // characterData omitted: causes CPU spike during streaming (every token = mutation)
    });

    cleanupRef.current = () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("scroll", handleScroll);
      if (scrollRafId) cancelAnimationFrame(scrollRafId);
      if (mutationRafId) cancelAnimationFrame(mutationRafId);
      clearTimeout(idleTimeoutId);
      clearTimeout(scrollIdleTimeoutId);
      el.classList.remove("scrolling");
      observer.disconnect();
    };
  }, [updateIsAtBottom]);

  // Ref callback — replaces RAF polling. Called by React whenever the DOM
  // element mounts, unmounts, or changes (conditional rendering swaps).
  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        attachTo(el);
      } else {
        // Element unmounted — cleanup
        if (cleanupRef.current) {
          cleanupRef.current();
          cleanupRef.current = null;
        }
        currentElRef.current = null;
      }
    },
    [attachTo],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  const handleScrollToBottom = useCallback(() => {
    userScrolledRef.current = false;
    const el = currentElRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, []);

  return { scrollRef, scrollElementRef: currentElRef, bottomRef, isAtBottom, scrollToBottom: handleScrollToBottom };
}
