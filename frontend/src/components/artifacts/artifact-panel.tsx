"use client";

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useArtifactStore } from "@/stores/artifact-store";
import { ArtifactPanelHeader } from "./artifact-panel-header";
import { ArtifactPanelContent } from "./artifact-panel-content";

/**
 * Mobile-only artifact sheet. On desktop the artifact renders as a section of
 * the unified task panel (src/components/task-panel/task-panel.tsx).
 */
export function ArtifactPanel() {
  const isOpen = useArtifactStore((s) => s.isOpen);
  const close = useArtifactStore((s) => s.close);
  const isDesktop = useIsDesktop();

  if (isDesktop) return null;

  // Mobile: Sheet overlay from right
  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-[90vw] sm:max-w-[520px] p-0">
        <VisuallyHidden.Root asChild>
          <SheetTitle>Artifact Preview</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>Preview of generated content</SheetDescription>
        </VisuallyHidden.Root>
        <div className="flex flex-col h-full">
          <ArtifactPanelHeader />
          <div className="flex-1 overflow-hidden">
            <ArtifactPanelContent />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
