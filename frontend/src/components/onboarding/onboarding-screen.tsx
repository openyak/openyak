"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  ArrowLeft,
  ShieldQuestion,
  Zap,
  ClipboardList,
  SlashSquare,
  AtSign,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AnimatedOpenYakLogo } from "@/components/layout/splash-screen";
import { useSettingsStore } from "@/stores/settings-store";

/** Three-step first-run flow: identity → the trust model → how to drive it. */
export function OnboardingScreen() {
  const { t } = useTranslation("common");
  const router = useRouter();
  const completeOnboarding = useSettingsStore((s) => s.completeOnboarding);
  const [step, setStep] = useState(0);

  const finish = () => completeOnboarding();
  const openProviderSetup = () => {
    completeOnboarding();
    router.push("/settings?tab=providers");
  };

  const steps = [
    <Step1 key="1" />,
    <Step2 key="2" />,
    <Step3 key="3" />,
  ];

  return (
    <div className="fixed inset-0 z-[9998] flex flex-col items-center justify-center bg-[var(--surface-primary)] px-6">
      {/* Skip is always available — onboarding must never trap a user. */}
      <button
        type="button"
        onClick={finish}
        className="absolute right-5 top-5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
      >
        {t("onbSkip")}
      </button>

      <div className="w-full max-w-md">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            {steps[step]}
          </motion.div>
        </AnimatePresence>

        {/* Footer: progress dots + navigation */}
        <div className="mt-10 flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden="true">
            {steps.map((_, i) => (
              <span
                key={i}
                className={
                  i === step
                    ? "h-1.5 w-5 rounded-full bg-[var(--brand-primary)] transition-all"
                    : "h-1.5 w-1.5 rounded-full bg-[var(--border-heavy)] transition-all"
                }
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep((s) => s - 1)}
              >
                <ArrowLeft className="mr-1 h-4 w-4" />
                {t("onbBack")}
              </Button>
            )}
            {step === 0 && (
              <>
                <Button variant="outline" size="sm" onClick={() => setStep(1)}>
                  {t("onbStep1Secondary")}
                </Button>
                <Button size="sm" onClick={openProviderSetup}>
                  {t("onbStep1Primary")}
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </>
            )}
            {step === 1 && (
              <Button size="sm" onClick={() => setStep(2)}>
                {t("onbNext")}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            {step === 2 && (
              <Button size="sm" onClick={finish}>
                {t("onbStep3Primary")}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step1() {
  const { t } = useTranslation("common");
  return (
    <div className="flex flex-col items-center text-center">
      <AnimatedOpenYakLogo size={72} />
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-[var(--text-primary)] text-balance">
        {t("onbStep1Title")}
      </h1>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-[var(--text-secondary)]">
        {t("onbStep1Body")}
      </p>
    </div>
  );
}

function ModeRow({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Zap;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-tertiary)] text-[var(--text-secondary)]">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">
          {body}
        </p>
      </div>
    </div>
  );
}

function Step2() {
  const { t } = useTranslation("common");
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)] text-balance">
        {t("onbStep2Title")}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        {t("onbStep2Body")}
      </p>
      <div className="mt-6 space-y-2.5">
        <ModeRow
          icon={ShieldQuestion}
          title={t("onbModeAskTitle")}
          body={t("onbModeAskBody")}
        />
        <ModeRow
          icon={Zap}
          title={t("onbModeAutoTitle")}
          body={t("onbModeAutoBody")}
        />
        <ModeRow
          icon={ClipboardList}
          title={t("onbModePlanTitle")}
          body={t("onbModePlanBody")}
        />
      </div>
    </div>
  );
}

function TipRow({
  icon: Icon,
  children,
}: {
  icon: typeof SlashSquare;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-secondary)] text-[var(--brand-primary)]">
        <Icon className="h-4 w-4" />
      </span>
      <p className="text-sm text-[var(--text-secondary)]">{children}</p>
    </div>
  );
}

function Step3() {
  const { t } = useTranslation("common");
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)] text-balance">
        {t("onbStep3Title")}
      </h1>
      <div className="mt-6 space-y-4">
        <TipRow icon={SlashSquare}>{t("onbStep3TipSlash")}</TipRow>
        <TipRow icon={AtSign}>{t("onbStep3TipMention")}</TipRow>
      </div>
    </div>
  );
}
