"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2, Star } from "lucide-react";
import { useProviderModels } from "@/hooks/use-provider-models";
import { useModelArenaMap, type ArenaScore } from "@/hooks/use-arena-scores";
import { useSettingsStore } from "@/stores/settings-store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usdToCreditsPerM, formatCreditsPerM } from "@/lib/pricing";
import type { ModelInfo } from "@/types/model";

type SortMode = "name" | "price" | "quality" | "popular" | "free";

function isFreeModel(m: ModelInfo): boolean {
  return m.pricing.prompt === 0 && m.pricing.completion === 0;
}

function isLegacyFreeRouterModel(m: ModelInfo): boolean {
  const normalizedName = m.name.trim().toLowerCase();
  return m.id === "openrouter/auto" || normalizedName === "free models router";
}

const SORT_BUTTONS: { key: SortMode; i18n: string }[] = [
  { key: "popular", i18n: "popular" },
  { key: "quality", i18n: "quality" },
  { key: "price", i18n: "price" },
  { key: "free", i18n: "free" },
  { key: "name", i18n: "name" },
];

export function HeaderModelDropdown() {
  const { t } = useTranslation("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortMode>("popular");
  const { data: models, isLoading, activeProvider } = useProviderModels();
  const { selectedModel, setSelectedModel } = useSettingsStore();
  const noModels = !activeProvider || (models ?? []).length === 0;
  const arenaMap = useModelArenaMap(models);
  const visibleModels = useMemo(
    () => (models ?? []).filter((m) => !isLegacyFreeRouterModel(m)),
    [models],
  );

  // Auto-select a sensible default when no model is selected or current model doesn't exist in the active provider
  useEffect(() => {
    if (visibleModels.length === 0) {
      if (selectedModel) setSelectedModel(null);
      return;
    }
    const modelExists = selectedModel && visibleModels.some((m) => m.id === selectedModel);
    if (!modelExists) {
      if (activeProvider === "openyak" || activeProvider === "byok") {
        // OpenYak/BYOK: prefer openyak/best-free, then first free model, then first visible
        const preferred = visibleModels.find((m) => m.id === "openyak/best-free");
        const fallback = visibleModels.find((m) => isFreeModel(m));
        setSelectedModel((preferred ?? fallback ?? visibleModels[0]).id);
      } else if (activeProvider === "chatgpt") {
        // ChatGPT subscription: prefer gpt-5.4, then first visible
        const preferred = visibleModels.find((m) => m.id === "openai-subscription/gpt-5.4");
        setSelectedModel((preferred ?? visibleModels[0]).id);
      } else {
        // Other providers: pick first visible model
        setSelectedModel(visibleModels[0].id);
      }
    }
  }, [visibleModels, selectedModel, setSelectedModel, activeProvider]);

  const { pinnedModel, freeModels, paidModels } = useMemo(() => {
    if (visibleModels.length === 0) return { pinnedModel: null, freeModels: [], paidModels: [] };

    let pinned: ModelInfo | null = null;
    const free: ModelInfo[] = [];
    const paid: ModelInfo[] = [];
    const isSubscription = activeProvider === "chatgpt";

    for (const m of visibleModels) {
      if (m.id === "openyak/best-free") pinned = m;
      else if (isFreeModel(m)) free.push(m);
      else paid.push(m);
    }

    // Subscription models: keep backend order (newest first). Others: sort normally.
    if (!isSubscription) {
      const makeSortFn = () => (a: ModelInfo, b: ModelInfo) => {
        if (sortBy === "price") return a.pricing.prompt - b.pricing.prompt;
        if (sortBy === "quality") {
          const sa = arenaMap.get(a.id)?.arenaScore ?? 0;
          const sb = arenaMap.get(b.id)?.arenaScore ?? 0;
          if (sa === 0 && sb === 0) return a.name.localeCompare(b.name);
          if (sa === 0) return 1;
          if (sb === 0) return -1;
          if (sa !== sb) return sb - sa;
          return a.name.localeCompare(b.name);
        }
        if (sortBy === "popular") {
          const va = arenaMap.get(a.id)?.popularityRank ?? 0;
          const vb = arenaMap.get(b.id)?.popularityRank ?? 0;
          if (va === 0 && vb === 0) return a.name.localeCompare(b.name);
          if (va === 0) return 1;
          if (vb === 0) return -1;
          if (va !== vb) return va - vb; // ascending: rank 1 first
          return a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name);
      };

      free.sort(makeSortFn());
      paid.sort(makeSortFn());
    }

    return { pinnedModel: pinned, freeModels: free, paidModels: paid };
  }, [visibleModels, sortBy, arenaMap, activeProvider]);

  const selectedName = visibleModels.find((m) => m.id === selectedModel)?.name;
  const shortModel = selectedName ?? (selectedModel ? (selectedModel.includes("/") ? selectedModel.split("/").pop() : selectedModel) : t("noModelFound"));

  // Models still loading with an active provider — show loading indicator
  if (isLoading && activeProvider) {
    return (
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-1.5 border-none bg-transparent shadow-none px-3 py-2 text-[15px] font-semibold text-[var(--text-tertiary)] rounded-xl h-auto w-auto max-w-[220px] focus:outline-none cursor-default"
      >
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span className="truncate">{t("loadingModels", "Loading models...")}</span>
      </button>
    );
  }

  // No models available — clicking navigates to provider settings instead of opening dropdown
  if (noModels) {
    return (
      <button
        type="button"
        onClick={() => router.push("/settings?tab=providers")}
        className="inline-flex items-center gap-1.5 border-none bg-transparent shadow-none px-3 py-2 text-[15px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] transition-colors rounded-xl h-auto w-auto max-w-[220px] focus:outline-none cursor-pointer"
      >
        <span className="truncate">{t("setupProvider")}</span>
        <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 border-none bg-transparent shadow-none px-3 py-2 text-[15px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors rounded-xl h-auto w-auto max-w-[220px] focus:outline-none cursor-pointer"
        >
          <span className="truncate">{shortModel}</span>
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0 overflow-hidden" align="start" sideOffset={4}>
        <TooltipProvider delayDuration={300}>
          <Command>
            <CommandInput placeholder={t("searchModels")} />
            {/* Sort bar */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border-default)]">
              <span className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider mr-auto">
                {t("sortBy")}
              </span>
              {SORT_BUTTONS.map(({ key, i18n }) => (
                <button
                  key={key}
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => setSortBy(key)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] rounded-md transition-colors",
                    sortBy === key
                      ? "bg-[var(--surface-secondary)] text-[var(--text-primary)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                  )}
                >
                  {t(i18n)}
                </button>
              ))}
            </div>
            <CommandList>
              <CommandEmpty>{t("noModelFound")}</CommandEmpty>

              {isLoading ? (
                <div className="px-3 py-2">
                  <div className="h-5 rounded-md bg-[var(--surface-tertiary)] animate-pulse" />
                </div>
              ) : (
                <>
                  {/* Pinned platform model at top */}
                  {pinnedModel && (
                    <CommandGroup>
                      <CommandItem
                        value={pinnedModel.name}
                        onSelect={() => {
                          setSelectedModel(pinnedModel.id);
                          setOpen(false);
                        }}
                        className="text-sm"
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4 shrink-0",
                            selectedModel === pinnedModel.id ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <Star className="mr-1.5 h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)] fill-[var(--text-tertiary)]" />
                        <span className="truncate flex-1 font-medium">{pinnedModel.name}</span>
                        <span className="ml-2 shrink-0 text-[10px] font-medium text-[var(--color-success)] bg-[var(--color-success)]/10 px-1.5 py-0.5 rounded">
                          FREE
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  )}

                  {/* Paid models first (hidden in free filter mode) */}
                  {sortBy !== "free" && paidModels.length > 0 && (
                    <CommandGroup heading={freeModels.length > 0 ? t("premium") : undefined}>
                      {paidModels.map((model) => (
                        <ModelRow
                          key={model.id}
                          model={model}
                          isSelected={selectedModel === model.id}
                          arena={arenaMap.get(model.id)}
                          sortBy={sortBy}
                          onSelect={() => {
                            setSelectedModel(model.id);
                            setOpen(false);
                          }}
                          t={t}
                        />
                      ))}
                    </CommandGroup>
                  )}

                  {/* Free models below */}
                  {freeModels.length > 0 && (
                    <CommandGroup heading={t("free")}>
                      {freeModels.map((model) => (
                        <ModelRow
                          key={model.id}
                          model={model}
                          isSelected={selectedModel === model.id}
                          arena={arenaMap.get(model.id)}
                          sortBy={sortBy}
                          onSelect={() => {
                            setSelectedModel(model.id);
                            setOpen(false);
                          }}
                          t={t}
                        />
                      ))}
                    </CommandGroup>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  model,
  isSelected,
  arena,
  sortBy,
  onSelect,
  t,
}: {
  model: ModelInfo;
  isSelected: boolean;
  arena: ArenaScore | undefined;
  sortBy: SortMode;
  onSelect: () => void;
  t: (key: string) => string;
}) {
  const free = isFreeModel(model);
  const isSubscription = model.provider_id === "openai-subscription";
  const inputCredits = usdToCreditsPerM(model.pricing.prompt);
  const outputCredits = usdToCreditsPerM(model.pricing.completion);

  const showArena =
    (sortBy === "quality" && arena && arena.arenaScore > 0) ||
    (sortBy === "popular" && arena && arena.popularityRank > 0);

  return (
    <CommandItem
      value={model.name}
      onSelect={onSelect}
      className="text-sm"
    >
      <Check
        className={cn(
          "mr-2 h-4 w-4 shrink-0",
          isSelected ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="truncate flex-1">{model.name}</span>
      {/* Right-side badge: contextual based on sort mode */}
      {isSubscription ? (
        <span className="ml-2 shrink-0 text-[10px] font-medium text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 px-1.5 py-0.5 rounded">
          INCLUDED
        </span>
      ) : model.provider_id === "ollama" ? (
        <span className="ml-2 shrink-0 text-[10px] font-medium text-[var(--text-tertiary)] bg-[var(--surface-tertiary)] px-1.5 py-0.5 rounded">
          LOCAL
        </span>
      ) : free ? (
        <span className="ml-2 shrink-0 text-[10px] font-medium text-[var(--color-success)] bg-[var(--color-success)]/10 px-1.5 py-0.5 rounded">
          FREE
        </span>
      ) : showArena && arena ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-2 shrink-0 text-[11px] font-mono tabular-nums text-[var(--text-tertiary)]">
              {sortBy === "quality" ? arena.arenaScore : `#${arena.popularityRank}`}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {arena.arenaScore > 0 && <div>Intelligence: {arena.arenaScore}</div>}
            {arena.popularityRank > 0 && <div>Popularity: #{arena.popularityRank}</div>}
            <div>{t("inputPrice")}: {formatCreditsPerM(inputCredits)}</div>
            <div>{t("outputPrice")}: {formatCreditsPerM(outputCredits)}</div>
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-2 shrink-0 text-[11px] font-mono tabular-nums text-[var(--text-tertiary)]">
              {formatCreditsPerM(inputCredits)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            <div>{t("inputPrice")}: {formatCreditsPerM(inputCredits)}</div>
            <div>{t("outputPrice")}: {formatCreditsPerM(outputCredits)}</div>
            {arena && arena.arenaScore > 0 && <div>Intelligence: {arena.arenaScore}</div>}
            {arena && arena.popularityRank > 0 && <div>Popularity: #{arena.popularityRank}</div>}
          </TooltipContent>
        </Tooltip>
      )}
    </CommandItem>
  );
}
