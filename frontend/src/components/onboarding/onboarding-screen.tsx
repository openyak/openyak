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

  const openProviderSetup = () => {
    completeOnboarding();
    router.push("/settings?tab=providers");
  };

  const startNow = () => {
    completeOnboarding();
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-[var(--surface-primary)]">
      <motion.div
        className="w-full max-w-sm px-6"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <div className="flex flex-col items-center text-center">
          <AnimatedOpenYakLogo size={80} />

          <h1 className="mt-8 text-2xl font-semibold text-[var(--text-primary)] tracking-tight">
            Welcome to OpenYak
          </h1>
          <p className="mt-2 max-w-xs text-sm text-[var(--text-secondary)]">
            Your local AI workbench. Connect your own provider, local endpoint,
            Rapid-MLX, Ollama, or ChatGPT subscription when you are ready.
          </p>

          <div className="mt-10 w-full space-y-3">
            <Button className="w-full" onClick={openProviderSetup}>
              Set Up Provider
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button variant="outline" className="w-full" onClick={startNow}>
              Continue
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
