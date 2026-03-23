"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  AlertCircle,
  Mail,
  RotateCw,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AnimatedOpenYakLogo } from "@/components/layout/splash-screen";
import { useAuthStore, type OpenYakUser } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { proxyApi, ProxyApiError } from "@/lib/proxy-api";
import { api } from "@/lib/api";
import { API, IS_DESKTOP, queryKeys } from "@/lib/constants";
import { desktopAPI } from "@/lib/tauri-api";

const PROXY_URL =
  process.env.NEXT_PUBLIC_DEFAULT_PROXY_URL || "https://api.open-yak.com";

type Step = "welcome" | "auth" | "done";

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 80 : -80,
    opacity: 0,
  }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({
    x: direction > 0 ? -80 : 80,
    opacity: 0,
  }),
};

export function OnboardingScreen() {
  const router = useRouter();
  const authStore = useAuthStore();
  const completeOnboarding = useSettingsStore((s) => s.completeOnboarding);
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>("welcome");
  const [direction, setDirection] = useState(1);

  // Auth state
  const [authMode, setAuthMode] = useState<"login" | "register">("register");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [verificationStep, setVerificationStep] = useState(false);
  const [codeInput, setCodeInput] = useState("");

  // Loading / error state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [codeCountdown, setCodeCountdown] = useState(600);

  useEffect(() => {
    if (!verificationStep) return;
    setCodeCountdown(600);
    const timer = setInterval(() => {
      setCodeCountdown(prev => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [verificationStep]);

  const goTo = (next: Step, dir = 1) => {
    setDirection(dir);
    setError(null);
    setStep(next);
  };

  const syncOpenYakAccountToBackend = async (proxyUrl: string, token: string, refreshToken?: string) => {
    const payload = { proxy_url: proxyUrl, token, ...(refreshToken && { refresh_token: refreshToken }) };
    try {
      await api.post(API.CONFIG.OPENYAK_ACCOUNT, payload);
      return;
    } catch {
      // Fallback: call backend directly via desktop IPC-resolved URL.
      if (IS_DESKTOP) {
        const backendUrl = await desktopAPI.getBackendUrl();
        const res = await fetch(`${backendUrl}${API.CONFIG.OPENYAK_ACCOUNT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) return;
      }
      throw new Error("Failed to connect local backend");
    }
  };

  /** Complete auth: fetch profile, connect backend, set store */
  const completeAuth = async (tokens: {
    access_token: string;
    refresh_token: string;
  }) => {
    const res = await fetch(`${PROXY_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) throw new Error("Failed to fetch profile");
    const user = (await res.json()) as OpenYakUser;

    await syncOpenYakAccountToBackend(PROXY_URL, tokens.access_token, tokens.refresh_token);

    authStore.setAuth({
      proxyUrl: PROXY_URL,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      user,
    });
    useSettingsStore.getState().setActiveProvider("openyak");
    qc.invalidateQueries({ queryKey: queryKeys.models });
    qc.invalidateQueries({ queryKey: queryKeys.openyakAccount });
  };

  const handleAuthSubmit = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      if (authMode === "login") {
        const tokens = await proxyApi.authPost<{
          access_token: string;
          refresh_token: string;
        }>(PROXY_URL, "/api/auth/login", {
          email: emailInput,
          password: passwordInput,
        });
        await completeAuth(tokens);
        goTo("done");
      } else {
        await proxyApi.authPost<{ message: string; email: string }>(
          PROXY_URL,
          "/api/auth/register",
          { email: emailInput, password: passwordInput },
        );
        setVerificationStep(true);
      }
    } catch (err) {
      if (err instanceof ProxyApiError) {
        setError(
          (err.body as Record<string, string>)?.detail ?? "Authentication failed",
        );
      } else {
        setError(err instanceof Error ? err.message : "Connection failed. Please check your network.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerify = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      const tokens = await proxyApi.authPost<{
        access_token: string;
        refresh_token: string;
      }>(PROXY_URL, "/api/auth/verify", {
        email: emailInput,
        code: codeInput,
      });
      await completeAuth(tokens);
      goTo("done");
    } catch (err) {
      if (err instanceof ProxyApiError) {
        setError(
          (err.body as Record<string, string>)?.detail ?? "Verification failed",
        );
      } else {
        setError(err instanceof Error ? err.message : "Verification failed");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = async () => {
    setError(null);
    setResendSuccess(false);
    try {
      await proxyApi.authPost(PROXY_URL, "/api/auth/resend", {
        email: emailInput,
      });
      setCodeInput("");
      setCodeCountdown(600);
      setResendSuccess(true);
    } catch {
      setError("Failed to resend code");
    }
  };

  const handleSkip = () => {
    completeOnboarding();
    router.push("/models");
  };

  const handleFinish = () => {
    completeOnboarding();
  };

  return (
    <motion.div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-[var(--surface-primary)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="w-full max-w-sm px-6">
        <AnimatePresence mode="wait" custom={direction}>
          {/* ─── Welcome ─── */}
          {step === "welcome" && (
            <motion.div
              key="welcome"
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="flex flex-col items-center text-center"
            >
              <AnimatedOpenYakLogo size={80} />

              <h1 className="mt-8 text-2xl font-semibold text-[var(--text-primary)] tracking-tight">
                Welcome to OpenYak
              </h1>
              <p className="mt-2 text-sm text-[var(--text-secondary)] max-w-xs">
                Your local AI assistant — private, powerful, personal.
                Create an account to get started with free AI models.
              </p>

              <div className="mt-10 w-full space-y-3">
                <Button
                  className="w-full"
                  onClick={() => {
                    setAuthMode("register");
                    goTo("auth");
                  }}
                >
                  Create Account
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setAuthMode("login");
                    goTo("auth");
                  }}
                >
                  Sign In
                </Button>
              </div>

              <button
                onClick={handleSkip}
                className="mt-8 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
              >
                Skip, I&apos;ll use my own API key
              </button>
            </motion.div>
          )}

          {/* ─── Auth ─── */}
          {step === "auth" && (
            <motion.div
              key="auth"
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="flex flex-col"
            >
              {/* Back button */}
              <button
                onClick={() => {
                  setVerificationStep(false);
                  setError(null);
                  setCodeInput("");
                  goTo("welcome", -1);
                }}
                className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors mb-8"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>

              <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-1">
                {authMode === "register" ? "Create your account" : "Welcome back"}
              </h2>
              <p className="text-sm text-[var(--text-secondary)] mb-6">
                {authMode === "register"
                  ? "Sign up to access free AI models with 1M tokens per day."
                  : "Sign in to your OpenYak account."}
              </p>

              {verificationStep ? (
                /* ─── Verification Code ─── */
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <Mail className="h-4 w-4 shrink-0" />
                    <span>
                      Code sent to <strong className="text-[var(--text-primary)]">{emailInput}</strong>
                    </span>
                  </div>

                  <p className="text-xs text-[var(--text-tertiary)]">
                    {codeCountdown > 0
                      ? `Code expires in ${Math.floor(codeCountdown / 60)}:${String(codeCountdown % 60).padStart(2, '0')}`
                      : "Code expired \u2014 please resend"}
                  </p>

                  <Input
                    type="text"
                    value={codeInput}
                    onChange={(e) =>
                      setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="6-digit code"
                    className="font-mono text-center text-lg tracking-[0.3em] h-12"
                    maxLength={6}
                    autoFocus
                  />

                  <Button
                    className="w-full"
                    onClick={handleVerify}
                    disabled={codeInput.length !== 6 || isSubmitting}
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Verify"
                    )}
                  </Button>

                  <div className="flex items-center justify-between">
                    <button
                      onClick={handleResend}
                      className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      <RotateCw className="h-3 w-3" />
                      Resend code
                    </button>
                    <button
                      onClick={() => {
                        setVerificationStep(false);
                        setCodeInput("");
                        setError(null);
                      }}
                      className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      Change email
                    </button>
                  </div>

                  {resendSuccess && (
                    <div className="flex items-center gap-1.5 text-xs text-[var(--color-success)]">
                      <Check className="h-3.5 w-3.5" />
                      New code sent
                    </div>
                  )}
                </div>
              ) : (
                /* ─── Email + Password Form ─── */
                <div className="space-y-4">
                  <div className="space-y-3">
                    <Input
                      type="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="Email"
                      autoFocus
                    />
                    <Input
                      type="password"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder={
                        authMode === "register"
                          ? "Password (min 8 characters)"
                          : "Password"
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && emailInput && passwordInput) {
                          handleAuthSubmit();
                        }
                      }}
                    />
                  </div>

                  <Button
                    className="w-full"
                    onClick={handleAuthSubmit}
                    disabled={!emailInput || !passwordInput || isSubmitting}
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : authMode === "register" ? (
                      "Create Account"
                    ) : (
                      "Sign In"
                    )}
                  </Button>

                  <div className="text-center">
                    <button
                      onClick={() => {
                        setAuthMode(authMode === "login" ? "register" : "login");
                        setError(null);
                      }}
                      className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      {authMode === "login"
                        ? "Don't have an account? Create one"
                        : "Already have an account? Sign in"}
                    </button>
                  </div>
                </div>
              )}

              {/* Error message */}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-1.5 mt-4 text-xs text-[var(--color-destructive)]"
                >
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{error}</span>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ─── Done ─── */}
          {step === "done" && (
            <motion.div
              key="done"
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="flex flex-col items-center text-center"
            >
              {/* Animated checkmark */}
              <motion.div
                className="h-16 w-16 rounded-full border-2 border-[var(--color-success)] flex items-center justify-center"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 20,
                  delay: 0.1,
                }}
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.3, type: "spring", stiffness: 400 }}
                >
                  <Check className="h-8 w-8 text-[var(--color-success)]" />
                </motion.div>
              </motion.div>

              <h2 className="mt-6 text-xl font-semibold text-[var(--text-primary)]">
                You&apos;re all set!
              </h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Signed in as{" "}
                <span className="text-[var(--text-primary)] font-medium">
                  {authStore.user?.email}
                </span>
              </p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                1M free tokens per day included
              </p>

              <Button className="w-full mt-8" onClick={handleFinish}>
                Start chatting
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
