"use client";

import { useState, useCallback } from "react";
import { useTranslation } from 'react-i18next';
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SquarePen, Share2, Loader2, ArrowLeft, List, Square } from "lucide-react";
import { HeaderModelDropdown } from "@/components/selectors/header-model-dropdown";
import { ContextIndicator } from "@/components/chat/context-indicator";
import { Button } from "@/components/ui/button";
import { OpenYakLogo } from "@/components/ui/openyak-logo";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useChatStore } from "@/stores/chat-store";
import { useMessages } from "@/hooks/use-messages";
import { API, IS_DESKTOP, resolveApiUrl } from "@/lib/constants";
import { isRemoteMode } from "@/lib/remote-connection";

interface ChatHeaderProps {
  sessionId?: string;
}

export function ChatHeader({ sessionId }: ChatHeaderProps) {
  const { t } = useTranslation('chat');
  const router = useRouter();
  const isCollapsed = useSidebarStore((s) => s.isCollapsed);
  const toggle = useSidebarStore((s) => s.toggle);
  const { messages } = useMessages(sessionId);
  const [pdfLoading, setPdfLoading] = useState(false);
  const remote = isRemoteMode();
  const isGenerating = useChatStore((s) => s.isGenerating);
  const streamingParts = useChatStore((s) => s.streamingParts);
  const streamId = useChatStore((s) => s.streamId);

  // Derive stream status label for remote mode
  const streamStatus = (() => {
    if (!remote || !isGenerating) return null;
    if (streamingParts.length === 0) return "Starting...";
    const lastPart = streamingParts[streamingParts.length - 1];
    if (lastPart.type === "tool" && lastPart.state.status === "running") return "Using tools...";
    return "Generating...";
  })();

  const handleAbort = useCallback(async () => {
    if (!streamId) return;
    try {
      const { api } = await import("@/lib/api");
      const { API: ApiRoutes } = await import("@/lib/constants");
      await api.post(ApiRoutes.CHAT.ABORT, { stream_id: streamId });
    } catch {
      // Abort is best-effort
    }
  }, [streamId]);

  const handleExportPdf = useCallback(async () => {
    if (!sessionId) return;
    setPdfLoading(true);
    try {
      const exportUrl = resolveApiUrl(API.SESSIONS.EXPORT_PDF(sessionId));

      if (IS_DESKTOP) {
        // WebView2 does not support blob-URL downloads via <a>.click(),
        // so use a Tauri command with native save dialog instead.
        const { desktopAPI } = await import("@/lib/tauri-api");
        await desktopAPI.downloadAndSave({ url: exportUrl, defaultName: "conversation.pdf" });
      } else {
        const res = await fetch(exportUrl);

        if (!res.ok) {
          const errorText = await res.text();
          let errorDetail = errorText;
          try {
            const errorJson = JSON.parse(errorText);
            errorDetail = errorJson.detail || errorText;
          } catch {
            // Not JSON, use text as-is
          }
          console.error("PDF export failed:", {
            status: res.status,
            statusText: res.statusText,
            detail: errorDetail
          });
          throw new Error(`PDF export failed: ${errorDetail}`);
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;

        let filename = "conversation.pdf";
        const disposition = res.headers.get("Content-Disposition");
        if (disposition) {
          const utf8Match = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
          if (utf8Match) {
            filename = decodeURIComponent(utf8Match[1]);
          } else {
            const asciiMatch = disposition.match(/filename="(.+?)"/);
            if (asciiMatch) filename = asciiMatch[1];
          }
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("PDF export error:", err);
    } finally {
      setPdfLoading(false);
    }
  }, [sessionId]);

  return (
    <TooltipProvider delayDuration={200}>
      <header className="flex h-13 items-center gap-1 px-3 bg-[var(--surface-primary)]/80 backdrop-blur-sm">
        {/* Remote mode: back + task list buttons */}
        {remote && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => router.push("/m")}
              aria-label="Back"
            >
              <ArrowLeft className="h-[18px] w-[18px]" />
            </Button>
          </>
        )}

        {/* Desktop mode: Sidebar toggle + new chat — visible when sidebar is collapsed */}
        {!remote && isCollapsed && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9" onClick={toggle} aria-label={t('toggleSidebar', { ns: 'common' })}>
                  <OpenYakLogo size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('openSidebar', { ns: 'common' })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t('newChat', { ns: 'common' })} asChild>
                  <Link href="/c/new">
                    <SquarePen className="h-[18px] w-[18px]" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('newChat', { ns: 'common' })}</TooltipContent>
            </Tooltip>
          </>
        )}

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <HeaderModelDropdown />
        </div>

        {/* Export PDF — desktop only */}
        {!remote && sessionId && messages && messages.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                aria-label={t('export')}
                onClick={handleExportPdf}
                disabled={pdfLoading}
              >
                {pdfLoading ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin" />
                ) : (
                  <Share2 className="h-[18px] w-[18px]" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('export')}</TooltipContent>
          </Tooltip>
        )}

        {/* Remote mode: stream status + abort, or task list button */}
        {remote && streamStatus && (
          <>
            <span className="text-[12px] text-[var(--text-tertiary)] animate-pulse whitespace-nowrap">
              {streamStatus}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/10"
              onClick={handleAbort}
              aria-label="Stop generation"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          </>
        )}
        {remote && !streamStatus && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => router.push("/m")}
            aria-label="Task list"
          >
            <List className="h-[18px] w-[18px] text-[var(--text-secondary)]" />
          </Button>
        )}

        {/* Context usage indicator — desktop only */}
        {!remote && sessionId && <ContextIndicator sessionId={sessionId} />}
      </header>
    </TooltipProvider>
  );
}
