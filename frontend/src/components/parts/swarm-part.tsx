"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleEllipsis,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { getTaskSubagentsRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type {
  AgentRunStatus,
  SwarmMemberPart,
  SwarmPart as SwarmPartType,
} from "@/types/message";

interface SwarmPartProps {
  data: SwarmPartType;
}

const STATUS_LABELS: Record<AgentRunStatus, string> = {
  pending: "statusPending",
  running: "statusRunning",
  waiting_input: "statusWaitingInput",
  completed: "statusCompleted",
  failed: "statusFailed",
  cancelled: "statusCancelled",
};

function MemberStatusIcon({ status }: { status: AgentRunStatus }) {
  const iconClass = "h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "running":
      return (
        <LoaderCircle
          className={cn(iconClass, "animate-spin text-[var(--brand-primary)]")}
          aria-hidden="true"
        />
      );
    case "waiting_input":
      return (
        <CircleEllipsis
          className={cn(iconClass, "text-[var(--color-warning)]")}
          aria-hidden="true"
        />
      );
    case "completed":
      return (
        <CheckCircle2
          className={cn(iconClass, "text-[var(--tool-completed)]")}
          aria-hidden="true"
        />
      );
    case "failed":
      return (
        <TriangleAlert
          className={cn(iconClass, "text-[var(--tool-error)]")}
          aria-hidden="true"
        />
      );
    case "cancelled":
      return (
        <Ban
          className={cn(iconClass, "text-[var(--text-tertiary)]")}
          aria-hidden="true"
        />
      );
    default:
      return (
        <Circle
          className={cn(iconClass, "text-[var(--text-quaternary)]")}
          aria-hidden="true"
        />
      );
  }
}

function AgentPill({
  member,
  parentSessionId,
}: {
  member: SwarmMemberPart;
  parentSessionId: string;
}) {
  const { t } = useTranslation("chat");
  const label = t(STATUS_LABELS[member.status]);

  return (
    <Link
      href={getTaskSubagentsRoute(parentSessionId, member.session_id)}
      aria-label={`${member.title}, ${label}. ${t("swarmOpenAgent")}`}
      title={`${member.title} · ${label}`}
      className="relative z-10 inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-primary)] px-2.5 text-[13px] font-medium leading-none text-[var(--text-secondary)] transition-[background-color,border-color,color] duration-150 hover:border-[var(--border-heavy)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <MemberStatusIcon status={member.status} />
      <span className="max-w-56 truncate">{member.title}</span>
    </Link>
  );
}

function MemberDetail({ member }: { member: SwarmMemberPart }) {
  const { t } = useTranslation("chat");
  const label = t(STATUS_LABELS[member.status]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium leading-5 text-[var(--text-secondary)]">
          {member.title}
        </span>
        <span className="block truncate text-[11px] leading-4 text-[var(--text-quaternary)]">
          {member.error || member.agent}
        </span>
      </span>
      <span className="flex items-center gap-1.5 pt-0.5 text-[11px] text-[var(--text-tertiary)]">
        <MemberStatusIcon status={member.status} />
        <span>{label}</span>
      </span>
    </div>
  );
}

function formatElapsed(startedAt: string, finishedAt: string | null | undefined, now: number) {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";

  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function SwarmPart({ data }: SwarmPartProps) {
  const { t } = useTranslation("chat");
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() =>
    Date.parse(data.finished_at ?? data.started_at),
  );

  useEffect(() => {
    if (data.status === "running") {
      setNow(Date.now());
      const timer = window.setInterval(() => setNow(Date.now()), 1_000);
      return () => window.clearInterval(timer);
    }

    setNow(Date.parse(data.finished_at ?? data.started_at));
  }, [data.finished_at, data.started_at, data.status]);

  const members = [...data.members].sort((a, b) => a.ordinal - b.ordinal);
  const completed = members.filter((member) => member.status === "completed").length;
  const active = members.filter((member) =>
    member.status === "running" || member.status === "waiting_input",
  ).length;
  const statusLabel = t(
    data.status === "partial"
      ? "statusPartial"
      : data.status === "failed"
        ? "statusFailed"
        : data.status === "cancelled"
          ? "statusCancelled"
          : data.status === "completed"
            ? "statusCompleted"
            : "statusRunning",
  );
  const elapsed = formatElapsed(data.started_at, data.finished_at, now);
  const isWaiting = members.some((member) => member.status === "waiting_input");
  const lifecycleLabel = t(
    data.status === "running"
      ? isWaiting
        ? "agentLifecycleWaiting"
        : "agentLifecycleStarted"
      : data.status === "cancelled"
        ? "agentLifecycleCancelled"
        : data.status === "failed"
          ? "agentLifecycleFailed"
          : "agentLifecycleFinished",
  );
  const detailsLabel = t(expanded ? "swarmHideDetails" : "swarmShowDetails");

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={`${t("swarmTitle")}: ${statusLabel}`}
      className="overflow-hidden py-1"
    >
      <div
        className="group/summary relative -mx-1 flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg px-1 py-0.5"
        title={elapsed ? t("swarmElapsed", { duration: elapsed }) : undefined}
      >
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={detailsLabel}
          className="absolute inset-0 rounded-lg transition-colors hover:bg-[var(--surface-secondary)]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
        />
        <div
          role="group"
          aria-label={t("swarmMembers")}
          className="relative z-10 flex min-w-0 flex-wrap items-center gap-1.5"
        >
          {members.map((member) => (
            <AgentPill
              key={member.agent_run_id}
              member={member}
              parentSessionId={data.parent_session_id}
            />
          ))}
        </div>
        <span className="pointer-events-none relative z-[1] text-[13px] leading-8 text-[var(--text-tertiary)]">
          {lifecycleLabel}
        </span>
        <ChevronRight
          className={cn(
            "pointer-events-none relative z-[1] size-3.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 group-hover/summary:text-[var(--text-secondary)]",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div
              id={detailsId}
              role="region"
              aria-label={t("swarmDetails")}
              className="ml-2 mt-1.5 border-l border-[var(--border-subtle)] pl-3"
            >
              <div className="flex items-center gap-2 pb-1 text-[11px] text-[var(--text-quaternary)]">
                <span>{t("swarmProgress", { completed, total: members.length, active })}</span>
                {elapsed && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t("swarmElapsed", { duration: elapsed })}</span>
                  </>
                )}
              </div>
              <div>
                {members.map((member) => (
                  <MemberDetail
                    key={member.agent_run_id}
                    member={member}
                  />
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
