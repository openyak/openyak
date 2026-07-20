"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SquarePen,
  Search,
  Settings as SettingsIcon,
  ClipboardList,
  Command as CommandIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export interface SlashCommand {
  id: string;
  label: string;
  hint?: string;
  /** Displayed on the right — a keyboard shortcut, purely informational. */
  shortcut?: string;
  icon: LucideIcon;
  run: () => void;
}

interface SlashCommandPopupProps {
  /** Text typed after the leading "/". */
  query: string;
  visible: boolean;
  commands: SlashCommand[];
  onRun: (command: SlashCommand) => void;
  onClose: () => void;
}

/**
 * Slash-command menu, opened by typing "/" at the start of the composer.
 * Deterministic app actions (new chat, plan mode, search, settings, compact)
 * plus their keyboard shortcuts, so the shortcuts are finally discoverable.
 * Mirrors the @mention popup's keyboard model and styling.
 */
export function SlashCommandPopup({
  query,
  visible,
  commands,
  onRun,
  onClose,
}: SlashCommandPopupProps) {
  const { t } = useTranslation("chat");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.hint?.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, visible]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (filtered[selectedIndex]) {
          e.preventDefault();
          e.stopPropagation();
          onRun(filtered[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [visible, filtered, selectedIndex, onRun, onClose],
  );

  useEffect(() => {
    if (visible) window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [visible, handleKeyDown]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-slash-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!visible) return null;

  return (
    <div className="absolute left-0 right-0 bottom-full mb-1 z-50">
      <div className="mx-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-primary)] shadow-[var(--shadow-md)] overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border-default)]">
          <p className="text-xs text-[var(--text-tertiary)]">
            {t("slashCommandsHeader")}
          </p>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={t("slashCommandsHeader")}
          className="max-h-[280px] overflow-y-auto py-1 scrollbar-auto"
        >
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-[var(--text-tertiary)]">
              {t("slashCommandsEmpty")}
            </div>
          )}
          {filtered.map((command, index) => {
            const Icon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                data-slash-item
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => onRun(command)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
                  index === selectedIndex
                    ? "bg-[var(--surface-secondary)]"
                    : "hover:bg-[var(--surface-secondary)]",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm text-[var(--text-primary)]">
                    {command.label}
                  </span>
                  {command.hint && (
                    <span className="block truncate text-xs text-[var(--text-tertiary)]">
                      {command.hint}
                    </span>
                  )}
                </span>
                {command.shortcut && (
                  <kbd className="shrink-0 rounded border border-[var(--border-default)] bg-[var(--surface-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-tertiary)]">
                    {command.shortcut}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Icons re-exported so the composer can build the command list without a
 *  second lucide import cluster. */
export const SlashIcons = {
  newChat: SquarePen,
  search: Search,
  settings: SettingsIcon,
  plan: ClipboardList,
  command: CommandIcon,
};
