"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

// Module-level flag: ensures splash only shows once per app session
let splashHasBeenShown = false;

/**
 * Animated logo component with fade-in effect
 */
export function AnimatedOpenYakLogo({ size = 80 }: { size?: number }) {
  return (
    <motion.img
      src="/favicon.svg"
      width={size}
      height={size}
      alt="OpenYak"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.0, ease: "easeInOut", delay: 0.2 }}
    />
  );
}

/**
 * Splash screen shown during app initialization
 * Displays animated logo and app name
 */
export function SplashScreen() {
  const [isVisible, setIsVisible] = useState(() => {
    if (splashHasBeenShown) return false;
    splashHasBeenShown = true;
    return true;
  });
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!isVisible) return;

    // Wait for initial content to load
    const readyTimer = setTimeout(() => {
      setIsReady(true);
    }, 1800); // Logo animation completes at ~1.6s

    // Start fade out after content is ready
    const hideTimer = setTimeout(() => {
      setIsVisible(false);
    }, 2200); // Give 400ms after ready state

    return () => {
      clearTimeout(readyTimer);
      clearTimeout(hideTimer);
    };
  }, [isVisible]);

  return (
    <AnimatePresence mode="wait">
      {isVisible && (
        <motion.div
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--surface-primary)]"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
        >
          {/* Animated logo — finite pulse only (Infinity repeat caused 100% CPU freeze on open) */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{
              scale: isReady ? [1, 1.05, 1] : [1, 1.03, 1],
              opacity: 1
            }}
            transition={{
              scale: {
                duration: 1.2,
                repeat: 2,
                repeatType: "reverse",
                ease: "easeInOut"
              },
              opacity: { duration: 0.3 }
            }}
          >
            <AnimatedOpenYakLogo size={120} />
          </motion.div>

          {/* App name - fades in after logo animation */}
          <motion.div
            className="mt-8 text-center"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.4 }}
          >
            <h1 className="text-3xl font-semibold text-[var(--text-primary)] tracking-wide">
              OPENYAK
            </h1>
            <p className="mt-2 text-sm text-[var(--text-tertiary)]">
              Local-first desktop agent
            </p>
          </motion.div>

          {/* Loading indicator - finite repeat to avoid CPU spike on open */}
          <motion.div
            className="mt-12 flex gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: isReady ? 0 : 0.5 }}
            transition={{ duration: 0.3, delay: 1.6 }}
          >
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="h-2 w-2 rounded-full bg-[var(--brand-primary)]"
                animate={{
                  scale: [1, 1.3, 1],
                  opacity: [0.3, 1, 0.3]
                }}
                transition={{
                  duration: 1.2,
                  repeat: 4,
                  delay: i * 0.2,
                  ease: "easeInOut"
                }}
              />
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
