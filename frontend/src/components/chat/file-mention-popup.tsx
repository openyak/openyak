"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { File as FileIcon } from "lucide-react";
import { useScrollbarActivity } from "@/hooks/use-scrollbar-activity";
import { searchFiles, type FileSearchResult } from "@/lib/upload";
import { cn } from "@/lib/utils";

interface FileMentionPopupProps {
  query: string;
  directory: string;
  onSelect: (result: FileSearchResult) => void;
  onClose: () => void;
  visible: boolean;
}

export function FileMentionPopup({
  query,
  directory,
  onSelect,
  onClose,
  visible,
}: FileMentionPopupProps) {
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useScrollbarActivity(listRef);

  // Fetch results with debounce
  useEffect(() => {
    if (!visible || !directory) {
      setResults([]);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchFiles(directory, query);
        setResults(data);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 150);

    return () => clearTimeout(debounceRef.current);
  }, [query, directory, visible]);

  // Keyboard navigation — attached to window so it works while textarea is focused
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (results[selectedIndex]) {
          onSelect(results[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (results[selectedIndex]) {
          onSelect(results[selectedIndex]);
        }
      }
    },
    [visible, results, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    if (visible) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [visible, handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-mention-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!visible) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50">
      <div className="mx-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-primary)] shadow-[var(--shadow-md)] overflow-hidden">
        {/* Header */}
        <div className="px-3 py-2 border-b border-[var(--border-default)]">
          <p className="text-xs text-[var(--text-tertiary)]">
            {query ? `Files matching "${query}"` : "Workspace files"}
          </p>
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-[240px] overflow-y-auto py-1 scrollbar-auto">
          {loading && results.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-4 justify-center text-[var(--text-tertiary)]">
              <span className="animate-spin h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full" />
              <span className="text-xs">Searching...</span>
            </div>
          )}

          {!loading && results.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-[var(--text-tertiary)]">
              No files found
            </div>
          )}

          {results.map((result, index) => (
            <button
              key={result.absolute_path}
              type="button"
              data-mention-item
              className={cn(
                "flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm transition-colors",
                index === selectedIndex
                  ? "bg-[var(--surface-secondary)]"
                  : "hover:bg-[var(--surface-secondary)]",
              )}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent textarea blur
                onSelect(result);
              }}
            >
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
              <span className="truncate text-[var(--text-primary)]">
                {result.name}
              </span>
              <span className="ml-auto truncate text-xs text-[var(--text-tertiary)] max-w-[50%]">
                {result.relative_path !== result.name
                  ? result.relative_path
                  : ""}
              </span>
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-1.5 border-t border-[var(--border-default)] flex items-center gap-3 text-[10px] text-[var(--text-tertiary)]">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
