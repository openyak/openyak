"use client";

import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { Button } from "@/components/ui/button";

export function UpdateBanner() {
  const { t } = useTranslation("settings");
  const { available, version, downloading, progress, downloadAndInstall, dismiss } = useUpdateCheck();

  return (
    <AnimatePresence>
      {available && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          className="overflow-hidden"
        >
          <div className="flex items-center justify-center gap-3 px-4 py-1.5 text-xs font-medium bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
            {downloading ? (
              <>
                <div className="flex items-center gap-2">
                  <div className="h-1 w-24 rounded-full bg-[var(--brand-primary)]/20 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--brand-primary)] transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <span>{t("updateDownloading")} {progress}%</span>
                </div>
              </>
            ) : (
              <>
                <Download className="h-3 w-3" />
                <span>{t("updateAvailableDesc", { version })}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-2 text-xs font-semibold text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20"
                  onClick={downloadAndInstall}
                >
                  {t("updateNow")}
                </Button>
                <button
                  onClick={dismiss}
                  className="ml-1 rounded p-0.5 hover:bg-[var(--brand-primary)]/20 transition-colors"
                  aria-label={t("updateLater")}
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
