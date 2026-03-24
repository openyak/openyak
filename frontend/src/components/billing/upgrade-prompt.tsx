"use client";

import { useTranslation } from "react-i18next";
import { Sparkles, CreditCard, Clock } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useBillingStore } from "@/stores/billing-store";

export function UpgradePrompt() {
  const { t } = useTranslation('billing');
  const { upgradeReason, dismissUpgrade } = useBillingStore();

  if (!upgradeReason) return null;

  const isQuotaExceeded = upgradeReason === "quota_exceeded";

  return (
    <Dialog open={!!upgradeReason} onOpenChange={(open) => !open && dismissUpgrade()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="mx-auto mb-2 h-12 w-12 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center">
            {isQuotaExceeded ? (
              <Clock className="h-6 w-6 text-[var(--brand-primary)]" />
            ) : (
              <Sparkles className="h-6 w-6 text-[var(--brand-primary)]" />
            )}
          </div>
          <DialogTitle className="text-center">
            {isQuotaExceeded
              ? t('dailyFreeQuotaReached')
              : t('creditsRequired')}
          </DialogTitle>
          <DialogDescription className="text-center">
            {isQuotaExceeded
              ? t('quotaExceededDesc')
              : t('creditsRequiredDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 mt-2">
          <Button asChild>
            <Link href="/settings?tab=billing" onClick={dismissUpgrade}>
              <CreditCard className="h-4 w-4 mr-2" />
              {t('buyCredits')}
            </Link>
          </Button>
          <Button variant="ghost" onClick={dismissUpgrade}>
            {isQuotaExceeded ? t('tryAgainTomorrow') : t('useFreeModel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
