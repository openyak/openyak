"use client";

import { CheckCircle2, Circle, Loader2, ChevronDown } from "lucide-react";
import { useWorkspaceStore, type WorkspaceTodo } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

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

export function ProgressCard() {
  const todos = useWorkspaceStore((s) => s.todos);
  const collapsed = useWorkspaceStore((s) => s.collapsedSections["progress"]);
  const toggleSection = useWorkspaceStore((s) => s.toggleSection);

  if (todos.length === 0) return null;

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] overflow-hidden">
      <button
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-[var(--surface-tertiary)]/50 transition-colors"
        onClick={() => toggleSection("progress")}
      >
        <span className="text-sm font-medium text-[var(--text-primary)]">
          Progress
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-[var(--text-tertiary)] transition-transform duration-200",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {!collapsed && (
        <div className="px-4 pb-3 space-y-0.5">
          {todos.map((todo, i) => (
            <TodoItem key={`${todo.content}-${i}`} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
}
