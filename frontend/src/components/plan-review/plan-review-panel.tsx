"use client";

import { X, ClipboardList, FileCode2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { usePlanReviewStore } from "@/stores/plan-review-store";

/** Read-only plan content viewer */
export function PlanReviewContent() {
  const { t } = useTranslation("chat");
  const planData = usePlanReviewStore((s) => s.planData);

  if (!planData) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border-default)]">
        <ClipboardList className="h-4 w-4 text-[var(--text-secondary)] shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 px-2 py-0.5 rounded-full">
              {t("planReadyForReview")}
            </span>
          </div>
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
            {t("planSelectText")}
          </p>
        </div>
        <button
          onClick={() => usePlanReviewStore.getState().close()}
          className="p-1.5 rounded-md hover:bg-[var(--surface-secondary)] transition-colors"
        >
          <X className="h-4 w-4 text-[var(--text-tertiary)]" />
        </button>
      </div>

      {/* Plan title */}
      <div className="px-5 pt-4 pb-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {planData.title}
        </h2>
      </div>

      {/* Plan content */}
      <div className="flex-1 overflow-y-auto px-5 pb-4 scrollbar-auto">
        <div className="prose prose-sm prose-invert max-w-none text-[var(--text-primary)] [&>h1]:text-lg [&>h1]:font-semibold [&>h2]:text-base [&>h2]:font-semibold [&>h3]:text-sm [&>h3]:font-semibold [&>p]:text-sm [&>p]:leading-relaxed [&>ul]:text-sm [&>ol]:text-sm [&_li]:leading-relaxed [&_code]:text-xs [&_pre]:text-xs [&_pre]:bg-[var(--surface-secondary)] [&_pre]:rounded-lg [&_pre]:p-3 [&_strong]:text-[var(--text-primary)]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {planData.plan}
          </ReactMarkdown>
        </div>

        {/* Files to modify */}
        {planData.filesToModify.length > 0 && (
          <div className="mt-4 pt-4 border-t border-[var(--border-default)]">
            <h3 className="text-xs font-medium text-[var(--text-secondary)] mb-2 flex items-center gap-1.5">
              <FileCode2 className="h-3.5 w-3.5" />
              {t("planFilesToModify")}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {planData.filesToModify.map((file) => (
                <span
                  key={file}
                  className="inline-flex items-center px-2 py-1 rounded-md bg-[var(--surface-secondary)] text-xs text-[var(--text-secondary)] font-mono"
                >
                  {file}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Mobile-only plan-review sheet. On desktop the pending plan renders as the
 * pinned top section of the unified task panel.
 */
export function PlanReviewPanel() {
  const isOpen = usePlanReviewStore((s) => s.isOpen);
  const close = usePlanReviewStore((s) => s.close);
  const isDesktop = useIsDesktop();

  if (isDesktop) return null;

  // Mobile: Sheet overlay from right
  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-[90vw] sm:max-w-[520px] p-0">
        <VisuallyHidden.Root asChild>
          <SheetTitle>Plan Review</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>Review the proposed implementation plan</SheetDescription>
        </VisuallyHidden.Root>
        <PlanReviewContent />
      </SheetContent>
    </Sheet>
  );
}
