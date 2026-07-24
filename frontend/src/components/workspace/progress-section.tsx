"use client";

import { CheckCircle2, Circle, Loader2, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore, type WorkspaceTodo } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

function TodoItem({ todo }: { todo: WorkspaceTodo }) {
  return (
    <div className="flex items-start gap-2.5 py-1">
      <div className="mt-0.5 shrink-0">
        {todo.status === "completed" ? (
          <CheckCircle2 className="h-4 w-4 text-[var(--tool-completed)]" />
        ) : todo.status === "in_progress" ? (
          <Loader2 className="h-4 w-4 text-[var(--brand-primary)] animate-spin" />
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

export function ProgressCard() {
  const { t } = useTranslation("chat");
  const todos = useWorkspaceStore((s) => s.todos);
  const collapsed = useWorkspaceStore((s) => s.collapsedSections["progress"]);
  const toggleSection = useWorkspaceStore((s) => s.toggleSection);
  const activeCount = todos.filter((todo) => todo.status !== "completed").length;
  const totalCount = todos.length;
  const previewItems = todos.slice(0, 3).map((todo) => ({ key: todo.content, status: todo.status }));

  if (totalCount === 0) return null;

  const progressSummary =
    activeCount === 0
      ? t("tasksCompleted", { count: totalCount })
      : t("activeTaskCount", { count: activeCount });

  return (
    <section className="overflow-hidden border-b border-[var(--border-subtle)]">
      <button
        className="flex w-full items-start justify-between px-4 py-4 text-left transition-colors hover:bg-[var(--surface-tertiary)]"
        onClick={() => toggleSection("progress")}
        aria-expanded={!collapsed}
        aria-controls="workspace-progress-content"
        aria-label={`Progress. ${progressSummary}`}
      >
        <div className="min-w-0 flex-1">
          <h2 className="block text-base font-normal text-[var(--text-tertiary)]">
            Progress
          </h2>
          <span className="mt-1 block text-[12px] text-[var(--text-tertiary)]">
            {progressSummary}
          </span>
          <div className="mt-3 flex items-center gap-1.5">
            {previewItems.map((item, i) => (
              <div key={`${item.key}-${i}`} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-6 w-6 rounded-full border flex items-center justify-center",
                    item.status === "completed"
                      ? "border-[var(--border-default)] bg-[var(--surface-tertiary)] text-[var(--tool-completed)]"
                      : item.status === "in_progress"
                        ? "border-[var(--text-accent)]/50 bg-[var(--text-accent)]/10 text-[var(--text-accent)]"
                        : "border-[var(--border-default)] text-[var(--text-quaternary)]",
                  )}
                >
                  {item.status === "completed" ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : item.status === "in_progress" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                </span>
                {i < previewItems.length - 1 && (
                  <span className="h-px w-3 bg-[var(--border-default)]" />
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="ml-3 flex items-center gap-2">
          <span className="rounded-full border border-[var(--border-default)] bg-[var(--surface-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
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
            id="workspace-progress-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[var(--border-subtle)] px-4 pb-4 pt-2 space-y-0.5">
              {todos.map((todo, i) => (
                <TodoItem key={`${todo.content}-${i}`} todo={todo} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
