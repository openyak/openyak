"use client";

import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnimatedOpenYakLogo } from "@/components/layout/splash-screen";
import { useSettingsStore } from "@/stores/settings-store";

export function OnboardingScreen() {
  const router = useRouter();
  const completeOnboarding = useSettingsStore((s) => s.completeOnboarding);

  const handleStart = () => {
    completeOnboarding();
    router.push("/settings?tab=providers");
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-[var(--surface-primary)]">
      <motion.div
        className="w-full max-w-sm px-6 flex flex-col items-center text-center"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <AnimatedOpenYakLogo size={80} />

        <h1 className="mt-8 text-2xl font-semibold text-[var(--text-primary)] tracking-tight">
          Welcome to OpenYak
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)] max-w-xs">
          Your local AI workspace — private, powerful, personal.
          Connect a model to get started.
        </p>

        <Button className="w-full mt-10" onClick={handleStart}>
          Configure a Model
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </motion.div>
    </div>
  );
}
