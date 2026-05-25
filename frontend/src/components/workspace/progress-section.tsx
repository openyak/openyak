"use client";

import { CheckCircle2, Circle, Loader2, ChevronDown, XCircle, Ban, GitBranch } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { useWorkspaceStore, type WorkspaceAgentTask, type WorkspaceTodo } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";
import { getChatRoute } from "@/lib/routes";

function TodoItem({ todo }: { todo: WorkspaceTodo }) {
  return (
    <div className="flex items-start gap-2.5 py-1">
      <div className="mt-0.5 shrink-0">
        {todo.status === "completed" ? (
          <CheckCircle2 className="h-4 w-4 text-[var(--tool-completed)]" />
        ) : todo.status === "in_progress" ? (
          <Loader2 className="h-4 w-4 text-[var(--text-accent)] animate-spin" />
        ) : (
          <Circle className="h-4 w-4 text-[var(--text-quaternary)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-[13px] leading-snug",
            todo.status === "completed"
              ? "text-[var(--text-tertiary)] line-through"
              : todo.status === "in_progress"
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-secondary)]",
          )}
        >
          {todo.content}
        </p>
        {todo.status === "in_progress" && todo.activeForm && (
          <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 animate-pulse">
            {todo.activeForm}
          </p>
        )}
      </div>
    </div>
  );
}

function AgentTaskIcon({ status }: { status: WorkspaceAgentTask["status"] }) {
  if (status === "completed") {
    return <CheckCircle2 className="h-4 w-4 text-[var(--tool-completed)]" />;
  }
  if (status === "running") {
    return <Loader2 className="h-4 w-4 text-[var(--text-accent)] animate-spin" />;
  }
  if (status === "failed") {
    return <XCircle className="h-4 w-4 text-[var(--tool-error)]" />;
  }
  if (status === "cancelled") {
    return <Ban className="h-4 w-4 text-[var(--text-tertiary)]" />;
  }
  return <Circle className="h-4 w-4 text-[var(--text-quaternary)]" />;
}

function AgentTaskItem({ task }: { task: WorkspaceAgentTask }) {
  const meta = [task.agent, task.model].filter(Boolean).join(" / ");
  const content = (
    <div className="flex items-start gap-2.5 py-1">
      <div className="mt-0.5 shrink-0">
        <AgentTaskIcon status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-[13px] leading-snug",
            task.status === "completed"
              ? "text-[var(--text-tertiary)]"
              : task.status === "failed"
                ? "text-[var(--tool-error)]"
                : task.status === "running"
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)]",
          )}
        >
          {task.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]">
          {task.error || meta || task.status}
        </p>
      </div>
      {task.session_id && (
        <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
      )}
    </div>
  );

  if (!task.session_id) return content;
  return (
    <Link href={getChatRoute(task.session_id)} className="block rounded-md hover:bg-white/[0.03]">
      {content}
    </Link>
  );
}

export function ProgressCard() {
  const { t } = useTranslation("chat");
  const todos = useWorkspaceStore((s) => s.todos);
  const taskBatch = useWorkspaceStore((s) => s.taskBatch);
  const collapsed = useWorkspaceStore((s) => s.collapsedSections["progress"]);
  const toggleSection = useWorkspaceStore((s) => s.toggleSection);
  const agentTasks = taskBatch?.tasks ?? [];
  const activeCount =
    todos.filter((todo) => todo.status !== "completed").length +
    agentTasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).length;
  const totalCount = todos.length + agentTasks.length;
  const previewItems = [
    ...todos.slice(0, 3).map((todo) => ({ key: todo.content, status: todo.status })),
    ...agentTasks.slice(0, 3).map((task) => ({ key: task.task_id, status: task.status })),
  ].slice(0, 3);

  if (totalCount === 0) return null;

  return (
    <div className="overflow-hidden rounded-3xl border border-white/8 bg-white/[0.03] shadow-[0_0_0_1px_rgba(255,255,255,0.02)_inset] backdrop-blur-sm">
      <button
        className="flex w-full items-start justify-between px-4 py-4 text-left transition-colors hover:bg-white/[0.02]"
        onClick={() => toggleSection("progress")}
      >
        <div className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-[var(--text-primary)]">
            Progress
          </span>
          <span className="mt-1 block text-[12px] text-[var(--text-tertiary)]">
            {activeCount === 0
              ? t("tasksCompleted", { count: totalCount })
              : t("activeTaskCount", { count: activeCount })}
          </span>
          <div className="mt-3 flex items-center gap-1.5">
            {previewItems.map((item, i) => (
              <div key={`${item.key}-${i}`} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-6 w-6 rounded-full border flex items-center justify-center",
                    item.status === "completed"
                      ? "border-white/20 bg-white/[0.06] text-[var(--tool-completed)]"
                      : item.status === "in_progress" || item.status === "running"
                        ? "border-[var(--text-accent)]/50 bg-[var(--text-accent)]/10 text-[var(--text-accent)]"
                        : item.status === "failed"
                          ? "border-[var(--tool-error)]/40 bg-[var(--tool-error)]/10 text-[var(--tool-error)]"
                        : "border-white/15 text-[var(--text-quaternary)]",
                  )}
                >
                  {item.status === "completed" ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : item.status === "in_progress" || item.status === "running" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : item.status === "failed" ? (
                    <XCircle className="h-3.5 w-3.5" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                </span>
                {i < previewItems.length - 1 && (
                  <span className="h-px w-3 bg-white/10" />
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="ml-3 flex items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
            {totalCount}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-[var(--text-tertiary)] transition-transform duration-200",
              collapsed && "-rotate-90",
            )}
          />
        </div>
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/6 px-4 pb-4 pt-2 space-y-0.5">
              {taskBatch && (
                <div className="pb-1">
                  <p className="px-0 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-quaternary)]">
                    {taskBatch.mode}
                  </p>
                  {agentTasks.map((task) => (
                    <AgentTaskItem key={task.task_id} task={task} />
                  ))}
                </div>
              )}
              {todos.map((todo, i) => (
                <TodoItem key={`${todo.content}-${i}`} todo={todo} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
