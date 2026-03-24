"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { IS_DESKTOP, TITLE_BAR_HEIGHT } from "@/lib/constants";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { useArtifactStore } from "@/stores/artifact-store";
import { ArtifactPanelHeader } from "./artifact-panel-header";
import { ArtifactPanelContent } from "./artifact-panel-content";

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

function ResizeHandle() {
  const setWidth = useArtifactStore((s) => s.setWidth);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startXRef.current = e.clientX;
      startWidthRef.current = useArtifactStore.getState().panelWidth;
    },
    [setWidth],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      // Panel is on the right, so dragging left = wider
      const delta = startXRef.current - e.clientX;
      setWidth(startWidthRef.current + delta);
    };

    const onMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    // Prevent text selection while dragging
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging, setWidth]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 group hover:bg-[var(--brand-primary)]/20 transition-colors"
    >
      <div className="absolute left-0 top-0 bottom-0 w-[3px] opacity-0 group-hover:opacity-100 bg-[var(--brand-primary)]/40 transition-opacity" />
    </div>
  );
}

export function ArtifactPanel() {
  const isOpen = useArtifactStore((s) => s.isOpen);
  const panelWidth = useArtifactStore((s) => s.panelWidth);
  const close = useArtifactStore((s) => s.close);
  const isDesktop = useIsDesktop();

  // Desktop: fixed right panel with smooth mount/unmount
  if (isDesktop) {
    return (
      <motion.aside
        className="fixed inset-y-0 right-0 z-[35] flex flex-col bg-[var(--surface-primary)] border-l border-[var(--border-default)] overflow-hidden"
        style={IS_DESKTOP ? { top: TITLE_BAR_HEIGHT } : undefined}
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: panelWidth, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
      >
        <ResizeHandle />
        <ArtifactPanelHeader />
        <div className="flex-1 overflow-hidden">
          <ArtifactPanelContent />
        </div>
      </motion.aside>
    );
  }

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
