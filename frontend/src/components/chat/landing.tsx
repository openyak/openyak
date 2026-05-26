"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Mail, FileDiff, CalendarDays, Settings,
  Receipt, FolderOpen, Trash2, Images, Table2,
  MessagesSquare,
} from "lucide-react";
import Link from "next/link";
import { useTranslation } from 'react-i18next';
import { ChatForm } from "./chat-form";
import { ChatHeader } from "./chat-header";
import { OfflineOverlay } from "@/components/layout/offline-overlay";
import { StreamingMessage } from "@/components/messages/assistant-message";
import { FileChip } from "./file-chip";
import { useChat } from "@/hooks/use-chat";
import { useChatStore } from "@/stores/chat-store";
import { useArtifactStore } from "@/stores/artifact-store";
import { useActivityStore } from "@/stores/activity-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";

const FEATURED_STARTERS = [
  { icon: Mail, textKey: "starterDraftFromNotes", promptKey: "starterDraftFromNotesPrompt" },
  { icon: FileDiff, textKey: "starterCompareDocs", promptKey: "starterCompareDocsPrompt" },
  { icon: CalendarDays, textKey: "starterWeeklyDigest", promptKey: "starterWeeklyDigestPrompt" },
  { icon: Receipt, textKey: "starterOrganizeBills", promptKey: "starterOrganizeBillsPrompt" },
  { icon: FolderOpen, textKey: "starterSummarizeFolder", promptKey: "starterSummarizeFolderPrompt" },
  { icon: Trash2, textKey: "starterCleanupFiles", promptKey: "starterCleanupFilesPrompt" },
  { icon: Images, textKey: "starterRenamePhotos", promptKey: "starterRenamePhotosPrompt" },
  { icon: Table2, textKey: "starterExtractPdfTables", promptKey: "starterExtractPdfTablesPrompt" },
];

const STARTERS_PER_MOUNT = 3;

interface LandingProps {
  directoryParam?: string | null;
}

function workspaceBasename(path: string | null | undefined): string | null {
  if (!path || path === ".") return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return last || null;
}

function pickRandomStarters(count: number): typeof FEATURED_STARTERS {
  const pool = [...FEATURED_STARTERS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function Landing({ directoryParam = null }: LandingProps) {
  const { t } = useTranslation('chat');
  const { sendMessage, sendTaskBatch, isGenerating, stopGeneration, pendingUserText, pendingAttachments, streamingParts, streamingText, streamingReasoning } = useChat();
  const globalWorkspace = useSettingsStore((s) => s.workspaceDirectory);
  const workspaceName = workspaceBasename(globalWorkspace);
  const activeProvider = useSettingsStore((s) => s.activeProvider);
  // Start with a deterministic slice so SSR and first client render match,
  // then shuffle post-mount. A new random pair is drawn every time Landing
  // remounts (i.e. every new chat opened).
  const [starters, setStarters] = useState(() =>
    FEATURED_STARTERS.slice(0, STARTERS_PER_MOUNT),
  );
  // `round` increments every refresh so each starter re-mounts
  // (keyed by round+index) and the flip animation replays — avoids the
  // "same textKey sampled twice in a row = no animation" trap.
  const [round, setRound] = useState(0);
  useEffect(() => {
    setStarters(pickRandomStarters(STARTERS_PER_MOUNT));
    setRound((r) => r + 1);
    const id = setInterval(() => {
      setStarters(pickRandomStarters(STARTERS_PER_MOUNT));
      setRound((r) => r + 1);
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const chat = useChatStore.getState();
    chat.resetSession(null);
    chat.setFocusedSession(null);
    useSettingsStore.getState().setWorkspaceDirectory(directoryParam || null);
    useArtifactStore.getState().clearAll();
    useActivityStore.getState().close();
  }, [directoryParam]);

  // Capture the user text in local state so it persists even after
  // startGeneration() clears pendingUserText from the global store.
  // This prevents the user bubble from flashing away before navigation.
  const capturedTextRef = useRef<string | null>(null);
  if (pendingUserText) {
    capturedTextRef.current = pendingUserText;
  }
  if (!isGenerating) {
    capturedTextRef.current = null;
  }
  const displayText = pendingUserText ?? capturedTextRef.current;

  // When generating, switch to a chat-like layout — uses the same
  // StreamingMessage component as chat-view for visual consistency.
  if (isGenerating) {
    return (
      <div className="relative flex flex-1 flex-col h-full overflow-hidden">
        <OfflineOverlay />
        <ChatHeader />

        {/* Messages area — optimistic user bubble + streaming assistant */}
        <div className="flex-1 overflow-y-auto">
          {displayText && (
            <div className="px-4 py-3">
              <div className="mx-auto max-w-3xl xl:max-w-4xl">
                <motion.div
                  className="flex justify-end"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl bg-[var(--user-bubble-bg)] px-4 py-2.5 shadow-[var(--shadow-sm)] border border-[var(--border-default)]">
                    <div className="text-[13px] text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">
                      {displayText}
                    </div>
                    {pendingAttachments && pendingAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {pendingAttachments.map((att) => (
                          <FileChip key={att.file_id} file={att} />
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              </div>
            </div>
          )}

          {/* Streaming assistant message — same component used in chat-view */}
          <div className="px-4 py-5">
            <div className="mx-auto max-w-3xl xl:max-w-4xl">
              <StreamingMessage
                sessionId={null}
                parts={streamingParts}
                streamingText={streamingText}
                streamingReasoning={streamingReasoning}
              />
            </div>
          </div>
        </div>

        {/* Input */}
        <ChatForm
          isGenerating={isGenerating}
          onSend={sendMessage}
          onSendTaskBatch={sendTaskBatch}
          onStop={stopGeneration}
          directory={globalWorkspace}
        />
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col h-full overflow-hidden">
      <OfflineOverlay />
      <ChatHeader />

      <div className="flex flex-1 flex-col items-center justify-center px-4 pb-8">
        <div className="w-full max-w-3xl xl:max-w-4xl">
          {/* Provider setup prompt */}
          {!activeProvider && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="mb-6 flex items-center gap-4 rounded-xl border border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5 px-5 py-4"
            >
              <Settings className="h-5 w-5 shrink-0 text-[var(--brand-primary)]" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {t('setupProvider')}
                </p>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {t('setupProviderDesc')}
                </p>
              </div>
              <Link
                href="/settings?tab=providers"
                className="shrink-0 inline-flex items-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors"
              >
                {t('configureSettings')}
              </Link>
            </motion.div>
          )}

          {/* Greeting — becomes workspace-aware when a folder is set, mirroring Codex */}
          <div className="mb-6 text-center pb-2">
            <h1 className="text-3xl sm:text-[2.5rem] font-medium text-[var(--text-primary)] tracking-tight">
              {workspaceName
                ? t('greetingInWorkspace', { workspace: workspaceName })
                : t('greeting')}
            </h1>
          </div>

          {/* Input — the focal point */}
          <ChatForm
            isGenerating={isGenerating}
            onSend={sendMessage}
            onSendTaskBatch={sendTaskBatch}
            onStop={stopGeneration}
            directory={globalWorkspace}
          />

          {/* Suggested starters — mx-7 aligns suggestion icons with the folder picker icon inside the input container */}
          <div className="-mt-3 mx-7" style={{ perspective: 1200 }}>
            <AnimatePresence mode="popLayout" initial={false}>
              {starters.map((starter, index) => (
                <motion.button
                  key={`${round}-${index}`}
                  initial={{ opacity: 0, rotateX: -90 }}
                  animate={{ opacity: 1, rotateX: 0 }}
                  exit={{ opacity: 0, rotateX: 90 }}
                  transition={{
                    duration: 0.55,
                    delay: index * 0.12,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  onClick={() => useArtifactStore.getState().requestFix(t(starter.promptKey))}
                  disabled={isGenerating}
                  className={cn(
                    "group flex w-full items-center gap-3 px-3 py-2.5 text-left text-[14px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed",
                    index > 0 && "border-t border-[var(--border-default)]/40",
                  )}
                >
                  <MessagesSquare className="h-[18px] w-[18px] shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]" strokeWidth={1.75} />
                  <span className="truncate">{t(starter.textKey)}</span>
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
