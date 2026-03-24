"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Mail, Globe, FileSpreadsheet, PenTool,
  FolderSearch, Trash2, Receipt, FolderSync, FileOutput,
  Layers, MailPlus, Image, FileDiff, FileSpreadsheet as TableIcon, CalendarDays,
  Keyboard, Upload, CornerDownLeft, Settings,
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

const ALL_CAPABILITIES = [
  { icon: PenTool, titleKey: "capDocumentDrafting", descKey: "capDocumentDraftingDesc" },
  { icon: FileSpreadsheet, titleKey: "capSpreadsheetAnalysis", descKey: "capSpreadsheetAnalysisDesc" },
  { icon: Search, titleKey: "capInformationRetrieval", descKey: "capInformationRetrievalDesc" },
  { icon: Globe, titleKey: "capWebResearch", descKey: "capWebResearchDesc" },
  { icon: FolderSync, titleKey: "capFileOrganization", descKey: "capFileOrganizationDesc" },
  { icon: FileOutput, titleKey: "capDataExtraction", descKey: "capDataExtractionDesc" },
  { icon: Layers, titleKey: "capBatchProcessing", descKey: "capBatchProcessingDesc" },
  { icon: MailPlus, titleKey: "capEmailCompose", descKey: "capEmailComposeDesc" },
];

const ALL_STARTERS = [
  { icon: Receipt, textKey: "starterOrganizeBills", promptKey: "starterOrganizeBillsPrompt" },
  { icon: FolderSearch, textKey: "starterSummarizeFolder", promptKey: "starterSummarizeFolderPrompt" },
  { icon: Trash2, textKey: "starterCleanupFiles", promptKey: "starterCleanupFilesPrompt" },
  { icon: Mail, textKey: "starterDraftFromNotes", promptKey: "starterDraftFromNotesPrompt" },
  { icon: Image, textKey: "starterRenamePhotos", promptKey: "starterRenamePhotosPrompt" },
  { icon: FileDiff, textKey: "starterCompareDocs", promptKey: "starterCompareDocsPrompt" },
  { icon: TableIcon, textKey: "starterExtractPdfTables", promptKey: "starterExtractPdfTablesPrompt" },
  { icon: CalendarDays, textKey: "starterWeeklyDigest", promptKey: "starterWeeklyDigestPrompt" },
];

/** Pick `count` random items from an array (Fisher-Yates). Stable per mount. */
function pickRandom<T>(items: T[], count: number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

export function Landing() {
  const { t } = useTranslation('chat');
  const { sendMessage, isGenerating, stopGeneration, pendingUserText, pendingAttachments, streamingParts, streamingText, streamingReasoning } = useChat();
  const globalWorkspace = useSettingsStore((s) => s.workspaceDirectory);
  const activeProvider = useSettingsStore((s) => s.activeProvider);

  // Pick random subsets on each mount — stable during the session
  const capabilities = useMemo(() => pickRandom(ALL_CAPABILITIES, 4), []);
  const starters = useMemo(() => pickRandom(ALL_STARTERS, 4), []);

  // Feature hints — only shown on first use
  const hasSeenHints = useSettingsStore((s) => s.hasSeenHints);
  const setHasSeenHints = useSettingsStore((s) => s.setHasSeenHints);
  const [showHints, setShowHints] = useState(!hasSeenHints);
  const isMac = useMemo(
    () => typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
    [],
  );

  // Auto-dismiss hints after 30 seconds
  useEffect(() => {
    if (!showHints) return;
    const timer = setTimeout(() => {
      setShowHints(false);
      setHasSeenHints(true);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [showHints, setHasSeenHints]);

  // Dismiss when user sends first message (isGenerating flips to true)
  useEffect(() => {
    if (isGenerating && showHints) {
      setShowHints(false);
      setHasSeenHints(true);
    }
  }, [isGenerating, showHints, setHasSeenHints]);

  useEffect(() => {
    const state = useChatStore.getState();
    if (!state.isGenerating) {
      state.reset();
    }
    // New chat starts with no workspace restriction (entire computer)
    useSettingsStore.getState().setWorkspaceDirectory(null);
    // Close right-side panels when landing page mounts (new chat / after delete)
    useArtifactStore.getState().clearAll();
    useActivityStore.getState().close();
  }, []);

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
                    <div className="text-[15px] text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">
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
        <div className="w-full max-w-3xl xl:max-w-4xl space-y-8">
          {/* Provider setup prompt */}
          {!activeProvider && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="flex items-center gap-4 rounded-xl border border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5 px-5 py-4"
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

          {/* Greeting */}
          <div className="text-center pb-2">
            <h1 className="text-3xl sm:text-4xl font-medium text-[var(--text-primary)] tracking-tight mb-2">
              {t('greeting')}
            </h1>
            <p className="text-sm text-[var(--text-secondary)] max-w-xl mx-auto">
              {t('subtitle')}
            </p>
          </div>

          {/* Input — the focal point */}
          <ChatForm
            isGenerating={isGenerating}
            onSend={sendMessage}
            onStop={stopGeneration}
            directory={globalWorkspace}
          />

          {/* Suggestion chips — below input */}
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            {starters.map((starter) => (
              <button
                key={starter.textKey}
                onClick={() => useArtifactStore.getState().requestFix(t(starter.promptKey))}
                disabled={isGenerating}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-heavy)] hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50"
              >
                <starter.icon className="h-3.5 w-3.5 shrink-0" />
                <span>{t(starter.textKey)}</span>
              </button>
            ))}
          </div>

          {/* Capabilities grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-4">
            {capabilities.map((capability, i) => (
              <motion.div
                key={capability.titleKey}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08, duration: 0.3 }}
                className="group rounded-lg border border-[var(--border-default)] p-3 hover:border-[var(--border-heavy)] hover:bg-[var(--surface-secondary)] hover:-translate-y-0.5 transition-all"
              >
                <capability.icon className="h-5 w-5 text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)] transition-colors mb-2" />
                <h3 className="text-[13px] font-semibold text-[var(--text-primary)] mb-0.5">
                  {t(capability.titleKey)}
                </h3>
                <p className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                  {t(capability.descKey)}
                </p>
              </motion.div>
            ))}
          </div>

          {/* First-use feature hints */}
          <AnimatePresence>
            {showHints && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: 0.5, duration: 0.4 }}
                className="flex flex-wrap justify-center gap-2 pt-2"
              >
                {[
                  { icon: Keyboard, label: `${isMac ? "\u2318" : "Ctrl"}+K new chat` },
                  { icon: Upload, label: "Drag files to attach" },
                  { icon: CornerDownLeft, label: "Enter to send, Shift+Enter for newline" },
                ].map((hint) => (
                  <span
                    key={hint.label}
                    className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)] bg-[var(--surface-secondary)] border border-[var(--border-default)] rounded-full px-2.5 py-1"
                  >
                    <hint.icon className="h-3 w-3 shrink-0" />
                    {hint.label}
                  </span>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
