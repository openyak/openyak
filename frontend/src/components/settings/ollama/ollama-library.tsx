"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Loader2,
  Square,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { API, getBackendUrl } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { LibraryData, LibraryModel } from "./types";

type SortMode = "popular" | "name" | "provider";

interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  message?: string;
}

export function ModelLibrary({
  library,
  installedNames,
  onPulled,
}: {
  library: LibraryData;
  installedNames: Set<string>;
  onPulled: () => void;
}) {
  const { t } = useTranslation("settings");
  const [activeCategory, setActiveCategory] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortMode>("popular");
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [customModel, setCustomModel] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Infinite scroll state
  const [allModels, setAllModels] = useState<LibraryModel[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Debounce search input (400ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(searchInput);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  // Reset pages when search/sort/category changes
  useEffect(() => {
    setPage(1);
    setAllModels([]);
    setHasMore(true);
  }, [debouncedQuery, activeCategory, sortBy]);

  // Fetch page of results
  const { data: libraryData, isLoading: libraryLoading } = useQuery({
    queryKey: ["ollamaLibrary", debouncedQuery, activeCategory, sortBy, page],
    queryFn: () => {
      const params = new URLSearchParams({ sort: sortBy, page: String(page) });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (activeCategory !== "all") params.set("category", activeCategory);
      return api.get<LibraryData>(`${API.OLLAMA.LIBRARY}?${params.toString()}`);
    },
  });

  // Append new page results to accumulated list
  useEffect(() => {
    if (!libraryData) return;
    setHasMore(!!libraryData.has_more);
    setLoadingMore(false);
    if (page === 1) {
      setAllModels(libraryData.models);
    } else {
      setAllModels((prev) => {
        const existing = new Set(prev.map((m) => m.name));
        const newModels = libraryData.models.filter((m) => !existing.has(m.name));
        return [...prev, ...newModels];
      });
    }
  }, [libraryData, page]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && !libraryLoading) {
          setLoadingMore(true);
          setPage((p) => p + 1);
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, libraryLoading]);

  const models = allModels.length > 0 ? allModels : (libraryData?.models ?? library.models);

  const pullAbortRef = useRef<AbortController | null>(null);

  const pullModel = useCallback(
    async (modelName: string) => {
      pullAbortRef.current?.abort();
      const abortController = new AbortController();
      pullAbortRef.current = abortController;

      setPullingModel(modelName);
      setPullProgress({ status: "starting" });

      try {
        const backendUrl = await getBackendUrl();
        const resp = await fetch(`${backendUrl}${API.OLLAMA.PULL}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: modelName }),
          signal: abortController.signal,
        });

        if (!resp.ok || !resp.body) {
          setPullProgress(null);
          setPullingModel(null);
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                setPullProgress(data);
                if (data.status === "error") {
                  setTimeout(() => {
                    setPullProgress(null);
                    setPullingModel(null);
                  }, 3000);
                  return;
                }
              } catch {
                // ignore
              }
            }
          }
        }

        setPullProgress(null);
        setPullingModel(null);
        pullAbortRef.current = null;
        onPulled();
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // User cancelled — clean up silently
        }
        setPullProgress(null);
        setPullingModel(null);
        pullAbortRef.current = null;
      }
    },
    [onPulled],
  );

  const cancelPull = useCallback(() => {
    pullAbortRef.current?.abort();
    pullAbortRef.current = null;
    setPullProgress(null);
    setPullingModel(null);
  }, []);

  const pullPercent =
    pullProgress?.total && pullProgress.total > 0
      ? Math.round(((pullProgress.completed ?? 0) / pullProgress.total) * 100)
      : 0;

  const categories = ["all", ...library.categories];
  const sortOptions: { key: SortMode; label: string }[] = [
    { key: "popular", label: t("sortPopular", "Popular") },
    { key: "name", label: t("sortName", "Name") },
    { key: "provider", label: t("sortProvider", "Provider") },
  ];

  return (
    <div>
      <h3 className="text-xs font-medium text-[var(--text-primary)] mb-2">
        {t("ollamaAddModels", "Add Models")}
      </h3>

      {/* Pull progress banner */}
      {pullingModel && pullProgress && (
        <div className="mb-3 rounded-lg border border-[var(--brand-primary)]/20 bg-[var(--brand-primary)]/5 p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--brand-primary)] shrink-0" />
            <span className="text-[var(--text-secondary)] flex-1">
              {pullProgress.status === "error"
                ? `Error: ${pullProgress.message ?? "Unknown error"}`
                : `Pulling ${pullingModel}... ${pullProgress.total ? `${pullPercent}%` : pullProgress.status}`}
            </span>
            <button
              onClick={cancelPull}
              className="text-[var(--text-tertiary)] hover:text-[var(--color-destructive)] transition-colors shrink-0"
              title={t("cancel", "Cancel")}
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          </div>
          {pullProgress.total && pullProgress.total > 0 && (
            <div className="w-full bg-[var(--surface-tertiary)] rounded-full h-1.5">
              <div
                className="bg-[var(--brand-primary)] h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${pullPercent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Search + sort + category tabs */}
      <div className="space-y-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
            <Input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("ollamaSearch", "Search models...")}
              className="pl-8 text-xs h-8"
            />
          </div>
          <div className="flex items-center border border-[var(--border-default)] rounded-md overflow-hidden shrink-0">
            {sortOptions.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={cn(
                  "px-2 py-1 text-[10px] transition-colors",
                  sortBy === key
                    ? "bg-[var(--surface-secondary)] text-[var(--text-primary)] font-medium"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-md transition-colors capitalize",
                activeCategory === cat
                  ? "bg-[var(--surface-secondary)] text-[var(--text-primary)] font-medium"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Model cards */}
      {libraryLoading && page === 1 ? (
        <div className="flex items-center gap-2 py-4 justify-center">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-tertiary)]" />
          <span className="text-xs text-[var(--text-tertiary)]">
            {debouncedQuery ? "Searching..." : "Loading..."}
          </span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {models.map((model) => (
              <ModelCard
                key={model.name}
                model={model}
                installedNames={installedNames}
                isPulling={pullingModel !== null}
                onPull={pullModel}
              />
            ))}
          </div>

          {models.length === 0 && !libraryLoading && (
            <p className="text-xs text-[var(--text-tertiary)] text-center py-3">
              {t("ollamaNoResults", "No models match your search.")}
            </p>
          )}

          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-3">
              {loadingMore && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
              )}
            </div>
          )}
        </>
      )}

      {/* Custom pull */}
      <div className="pt-2 border-t border-[var(--border-default)]">
        <p className="text-[10px] text-[var(--text-tertiary)] mb-1.5">
          {t("ollamaCustomPull", "Or pull any model by name:")}
        </p>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="e.g. llama3.2:1b"
            className="font-mono text-xs h-8"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              if (customModel.trim()) {
                pullModel(customModel.trim());
                setCustomModel("");
              }
            }}
            disabled={!customModel.trim() || pullingModel !== null}
          >
            {t("pull", "Pull")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Model Card                                                          */
/* ------------------------------------------------------------------ */

function ModelCard({
  model,
  installedNames,
  isPulling,
  onPull,
}: {
  model: LibraryModel;
  installedNames: Set<string>;
  isPulling: boolean;
  onPull: (name: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] p-3 space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--text-primary)]">{model.name}</span>
          {(model.pulls_formatted || (model.pulls != null && model.pulls > 0)) && (
            <span className="text-[9px] text-[var(--text-tertiary)]">
              {model.pulls_formatted || `${model.pulls?.toLocaleString()}`} pulls
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {model.provider && (
            <span className="text-[10px] text-[var(--text-tertiary)]">{model.provider}</span>
          )}
          {model.capabilities?.map((cap) => (
            <span
              key={cap}
              className="text-[9px] px-1 py-px rounded bg-[var(--surface-tertiary)] text-[var(--text-tertiary)]"
            >
              {cap}
            </span>
          ))}
        </div>
      </div>
      {model.desc && (
        <p className="text-[10px] text-[var(--text-secondary)] line-clamp-2">{model.desc}</p>
      )}
      <div className="flex items-center gap-1 flex-wrap">
        {model.sizes.map((size) => {
          const fullName = `${model.name}:${size}`;
          const isInstalled = installedNames.has(fullName);
          return (
            <button
              key={size}
              onClick={() => !isInstalled && !isPulling && onPull(fullName)}
              disabled={isInstalled || isPulling}
              className={cn(
                "px-1.5 py-0.5 text-[10px] rounded border transition-colors",
                isInstalled
                  ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-success)] cursor-default"
                  : "border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] cursor-pointer",
                isPulling && !isInstalled && "opacity-50 cursor-not-allowed",
              )}
              title={isInstalled ? "Installed" : `Pull ${fullName}`}
            >
              {isInstalled && <Check className="h-2.5 w-2.5 inline mr-0.5" />}
              {size}
            </button>
          );
        })}
      </div>
    </div>
  );
}
