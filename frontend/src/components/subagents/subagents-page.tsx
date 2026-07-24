"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleEllipsis,
  LoaderCircle,
  Network,
  Plus,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { StreamStatusLine } from "@/components/chat/stream-status-line";
import { PermissionDialog } from "@/components/interactive/permission-dialog";
import { PlanAcceptPrompt } from "@/components/interactive/plan-accept-prompt";
import { QuestionPrompt } from "@/components/interactive/question-prompt";
import { TextPart } from "@/components/parts/text-part";
import { useChat } from "@/hooks/use-chat";
import { useSubagents } from "@/hooks/use-subagents";
import { useMessages } from "@/hooks/use-messages";
import { getChatRoute, getTaskSubagentsRoute } from "@/lib/routes";
import { extractTextFromPartResponses } from "@/lib/utils";
import type { AgentRunStatus } from "@/types/message";
import type { SubagentRun } from "@/types/subagent";
import { SubagentRow } from "./subagent-row";
import { composeSubagentResponse } from "./subagent-response";

const ACTIVE_VISIBLE_LIMIT = 4;
const DONE_VISIBLE_LIMIT = 10;

interface SubagentSectionProps {
  runs: SubagentRun[];
  parentSessionId: string;
  active?: boolean;
}

function SubagentSection({
  runs,
  parentSessionId,
  active = false,
}: SubagentSectionProps) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const limit = active ? ACTIVE_VISIBLE_LIMIT : DONE_VISIBLE_LIMIT;
  const visibleRuns = expanded ? runs : runs.slice(0, limit);
  const hiddenCount = Math.max(0, runs.length - limit);

  return (
    <div className="flex flex-col gap-1">
      {visibleRuns.map((run) => (
        <SubagentRow
          key={run.id}
          run={run}
          parentSessionId={parentSessionId}
          active={active}
          previewLineCount={active ? 2 : 1}
        />
      ))}
      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 inline-flex min-h-8 w-fit items-center gap-1 rounded-md px-1.5 text-sm text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
          {t("subagentsShowMore", { count: hiddenCount })}
        </button>
      )}
    </div>
  );
}

const ACTIVE_STATUSES = new Set<AgentRunStatus>([
  "pending",
  "running",
  "waiting_input",
]);

function formatRunDuration(run: SubagentRun): string {
  if (!run.started_at) return "";
  const startedAt = new Date(run.started_at).getTime();
  const endedAt = run.finished_at
    ? new Date(run.finished_at).getTime()
    : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return "";

  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function RunStatusIcon({ status }: { status: AgentRunStatus }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return (
        <LoaderCircle
          className={`${className} animate-spin text-[var(--brand-primary)]`}
          aria-hidden="true"
        />
      );
    case "waiting_input":
      return (
        <CircleEllipsis
          className={`${className} text-[var(--color-warning)]`}
          aria-hidden="true"
        />
      );
    case "completed":
      return (
        <CheckCircle2
          className={`${className} text-[var(--tool-completed)]`}
          aria-hidden="true"
        />
      );
    case "failed":
      return (
        <TriangleAlert
          className={`${className} text-[var(--tool-error)]`}
          aria-hidden="true"
        />
      );
    case "cancelled":
      return (
        <Ban
          className={`${className} text-[var(--text-tertiary)]`}
          aria-hidden="true"
        />
      );
    default:
      return (
        <Circle
          className={`${className} text-[var(--text-quaternary)]`}
          aria-hidden="true"
        />
      );
  }
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-[var(--border-subtle)] py-6 first:border-t-0 first:pt-0">
      <h2 className="mb-3 text-[13px] font-medium leading-5 text-[var(--text-tertiary)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubagentDetail({ run }: { run: SubagentRun }) {
  const { t } = useTranslation("common");
  const { t: tChat } = useTranslation("chat");
  const detailRef = useRef<HTMLDivElement>(null);
  const { messages, isLoading, isError, refetch } = useMessages(run.session_id);
  const runIsActive = ACTIVE_STATUSES.has(run.status);
  const {
    respondToPermission,
    respondToQuestion,
    respondToPlanReview,
    isGenerating,
    streamingParts,
    streamingText,
    pendingPermission,
    pendingQuestion,
    pendingPlanReview,
  } = useChat(run.session_id, { syncRemote: runIsActive });

  useEffect(() => {
    detailRef.current?.focus();
  }, []);
  const statusLabels: Record<AgentRunStatus, string> = {
    pending: tChat("statusPending"),
    running: tChat("statusRunning"),
    waiting_input: tChat("statusWaitingInput"),
    completed: tChat("statusCompleted"),
    failed: tChat("statusFailed"),
    cancelled: tChat("statusCancelled"),
  };
  const delegatedTask =
    messages
      .filter((message) => message.data.role === "user")
      .map((message) => extractTextFromPartResponses(message.parts).trim())
      .find(Boolean) ?? "";
  const persistedResponse =
    [...messages]
      .reverse()
      .filter((message) => message.data.role === "assistant")
      .map((message) =>
        message.parts
          .flatMap((part) =>
            part.data.type === "text" ? [part.data.text.trim()] : [],
          )
          .filter(Boolean)
          .join("\n\n"),
      )
      .find(Boolean) ?? "";
  const finalResponse = composeSubagentResponse({
    persistedText: persistedResponse,
    streamingParts,
    streamingText,
  });
  const isActive = runIsActive || isGenerating;
  const duration = formatRunDuration(run);

  const delegatedTaskContent = (() => {
    if (isLoading) {
      return (
        <p role="status" className="text-sm text-[var(--text-tertiary)]">
          {t("subagentTaskLoading")}
        </p>
      );
    }
    if (isError || !delegatedTask) {
      return (
        <p className="text-sm text-[var(--text-tertiary)]">
          {t("subagentTaskUnavailable")}
        </p>
      );
    }
    return <TextPart data={{ type: "text", text: delegatedTask }} />;
  })();

  const responseContent = (() => {
    if (finalResponse) {
      return (
        <div>
          {isActive && (
            <p
              role="status"
              className="mb-3 flex items-center gap-2 text-xs text-[var(--text-tertiary)]"
            >
              <span
                className="size-1.5 rounded-full bg-[var(--brand-primary)]"
                aria-hidden="true"
              />
              {t("subagentLiveResponse")}
            </p>
          )}
          <TextPart
            data={{ type: "text", text: finalResponse }}
            isStreaming={isActive}
          />
          {run.status === "failed" && (
            <p
              role="alert"
              className="mt-4 text-sm text-[var(--tool-error)]"
            >
              {run.error || t("subagentResponseFailed")}
            </p>
          )}
          {run.status === "cancelled" && (
            <p className="mt-4 text-sm text-[var(--text-tertiary)]">
              {run.error || t("subagentResponseCancelled")}
            </p>
          )}
        </div>
      );
    }
    if (isLoading) {
      return (
        <p role="status" className="text-sm text-[var(--text-tertiary)]">
          {t("subagentResponseLoading")}
        </p>
      );
    }
    if (isError) {
      return (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-tertiary)]"
        >
          <span>{t("subagentHistoryUnavailable")}</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <RotateCw className="size-3.5" aria-hidden="true" />
            {t("retry")}
          </button>
        </div>
      );
    }
    if (run.status === "failed") {
      return (
        <p role="alert" className="text-sm text-[var(--tool-error)]">
          {run.error || t("subagentResponseFailed")}
        </p>
      );
    }
    if (run.status === "cancelled") {
      return (
        <p className="text-sm text-[var(--text-tertiary)]">
          {run.error || t("subagentResponseCancelled")}
        </p>
      );
    }
    return (
      <div
        role={isActive ? "status" : undefined}
        className="text-sm text-[var(--text-tertiary)]"
      >
        {isActive && (
          <p className="mb-2 text-xs">{t("subagentLiveResponse")}</p>
        )}
        <p>
          {isActive
            ? t("subagentResponseWaiting")
            : t("subagentResponseUnavailable")}
        </p>
      </div>
    );
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-auto">
        <div
          ref={detailRef}
          role="region"
          aria-label={t("subagentDetails")}
          tabIndex={-1}
          className="mx-auto w-full max-w-[760px] px-6 pb-24 pt-8 focus:outline-none"
        >
          <div className="mb-7 flex min-w-0 items-center gap-2">
            <Link
              href={getTaskSubagentsRoute(run.parent_session_id)}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              aria-label={t("backToSubagents")}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </Link>
            <p className="min-w-0 truncate text-[15px] font-medium leading-5 text-[var(--text-primary)]">
              {run.title}
            </p>
          </div>
          <DetailSection title={t("subagentStatus")}>
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-sm text-[var(--text-primary)]"
            >
              <RunStatusIcon status={run.status} />
              <span>{statusLabels[run.status]}</span>
              {duration && (
                <>
                  <span
                    className="text-[var(--text-quaternary)]"
                    aria-hidden="true"
                  >
                    ·
                  </span>
                  <span className="text-[var(--text-secondary)]">{duration}</span>
                </>
              )}
            </div>
          </DetailSection>
          <DetailSection title={t("subagentDelegatedTask")}>
            {delegatedTaskContent}
          </DetailSection>
          <DetailSection title={t("subagentFinalResponse")}>
            {responseContent}
          </DetailSection>
        </div>
      </div>

      <StreamStatusLine
        sessionId={run.session_id}
        className="px-6 pb-2"
        contentClassName="max-w-[712px]"
      />

      {pendingPermission && (
        <PermissionDialog
          permission={pendingPermission}
          onRespond={respondToPermission}
        />
      )}

      {pendingQuestion && (
        <QuestionPrompt
          question={pendingQuestion}
          onRespond={respondToQuestion}
        />
      )}

      {pendingPlanReview && (
        <PlanAcceptPrompt onRespond={respondToPlanReview} />
      )}
    </div>
  );
}

interface SubagentsWorkViewProps {
  parentSessionId: string;
  selectedSessionId?: string | null;
}

export function SubagentsWorkView({
  parentSessionId,
  selectedSessionId = null,
}: SubagentsWorkViewProps) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const { data, isError, isFetching, isPlaceholderData, refetch } =
    useSubagents(parentSessionId);
  const active = data?.active ?? [];
  const done = data?.done ?? [];
  const counts = data?.counts ?? { active: 0, done: 0, total: 0 };
  const selectedRun = selectedSessionId
    ? [...active, ...done].find(
        (run) => run.session_id === selectedSessionId,
      ) ?? null
    : null;
  const closeHref = getChatRoute(parentSessionId);
  const loading =
    isFetching && isPlaceholderData && counts.total === 0;

  useEffect(() => {
    if (
      selectedSessionId &&
      !isPlaceholderData &&
      !isFetching &&
      !selectedRun
    ) {
      router.replace(getTaskSubagentsRoute(parentSessionId));
    }
  }, [
    isFetching,
    isPlaceholderData,
    parentSessionId,
    router,
    selectedRun,
    selectedSessionId,
  ]);

  useEffect(() => {
    if (!selectedSessionId) {
      listHeadingRef.current?.focus();
    }
  }, [selectedSessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--surface-chat)]">
      <h1
        ref={listHeadingRef}
        tabIndex={-1}
        className="sr-only"
      >
        {t("subagents")}
      </h1>
      <header className="flex h-12 shrink-0 items-center px-3 pl-14 lg:pl-3">
        <div className="flex h-7 w-full min-w-0 max-w-[156px] items-center gap-1.5 rounded-lg bg-[var(--surface-selected)] px-2 text-[var(--text-primary)]">
          <Network className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5">
            {t("subagents")}
          </span>
          <Link
            href={closeHref}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            aria-label={t("backToParentTask")}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
        <Link
          href="/c/new"
          className="ml-2 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          aria-label={t("newChat")}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Link>
      </header>

      {selectedRun ? (
        <SubagentDetail run={selectedRun} />
      ) : selectedSessionId && (isPlaceholderData || isFetching) ? (
        <div className="flex flex-1 items-center justify-center text-[14px] leading-5 text-[var(--text-tertiary)]">
          {t("subagentsLoading")}
        </div>
      ) : (
        <div className="h-full min-h-0 overflow-y-auto px-3 py-5 scrollbar-auto">
          <section aria-labelledby="active-subagents-heading">
            <h2
              id="active-subagents-heading"
              className="mb-3 text-[14px] font-normal leading-5 text-[var(--text-tertiary)]"
            >
              {t("subagentsActive")}
            </h2>
            {loading ? (
              <p className="text-[14px] leading-5 text-[var(--text-tertiary)]">
                {t("subagentsLoading")}
              </p>
            ) : active.length > 0 ? (
              <SubagentSection
                runs={active}
                parentSessionId={parentSessionId}
                active
              />
            ) : (
              <p className="text-[14px] leading-5 text-[var(--text-tertiary)]">
                {t("noActiveSubagents")}
              </p>
            )}
          </section>

          <section className="mt-7" aria-labelledby="done-subagents-heading">
            <h2
              id="done-subagents-heading"
              className="mb-2 text-[14px] font-normal leading-5 text-[var(--text-tertiary)]"
            >
              {t("subagentsDoneCount", { count: counts.done })}
            </h2>
            <SubagentSection
              runs={done}
              parentSessionId={parentSessionId}
            />
          </section>

          {isError && (
            <div
              role="alert"
              className="mt-6 flex items-center gap-2 text-[14px] leading-5 text-[var(--color-destructive)]"
            >
              <span>{t("subagentsLoadFailed")}</span>
              <button
                type="button"
                onClick={() => void refetch()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              >
                <RotateCw className="size-3.5" aria-hidden="true" />
                {t("retry")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compatibility surface for bookmarks made before Subagents became a task tab. */
export function SubagentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const parentSessionId = searchParams.get("parent");
  const selectedSessionId = searchParams.get("child");

  useEffect(() => {
    router.replace(
      parentSessionId
        ? getTaskSubagentsRoute(parentSessionId, selectedSessionId)
        : "/c/new",
    );
  }, [parentSessionId, router, selectedSessionId]);

  return null;
}
