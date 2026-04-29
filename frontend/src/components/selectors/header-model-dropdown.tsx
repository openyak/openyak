"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, ChevronDown, Loader2, Star } from "lucide-react";
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

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Gemini", groq: "Groq",
  deepseek: "DeepSeek", mistral: "Mistral", xai: "xAI", together: "Together",
  deepinfra: "DeepInfra", cerebras: "Cerebras", cohere: "Cohere",
  perplexity: "Perplexity", fireworks: "Fireworks", azure: "Azure",
  openrouter: "OpenRouter",
  qwen: "Qwen",
  kimi: "Kimi",
  minimax: "MiniMax",
  zhipu: "ZhipuAI",
  siliconflow: "SiliconFlow",
  xiaomi: "MiMo",
};

type SortMode = "name" | "price" | "quality" | "popular" | "free";

function isFreeModel(m: ModelInfo): boolean {
  return m.pricing.prompt === 0 && m.pricing.completion === 0;
}

function isLegacyFreeRouterModel(m: ModelInfo): boolean {
  const normalizedName = m.name.trim().toLowerCase();
  return m.id === "openrouter/auto" || normalizedName === "free models router";
}

const SORT_BUTTONS_FULL: { key: SortMode; i18n: string }[] = [
  { key: "popular", i18n: "popular" },
  { key: "quality", i18n: "quality" },
  { key: "price", i18n: "price" },
  { key: "free", i18n: "free" },
  { key: "name", i18n: "name" },
];

const SORT_BUTTONS_SIMPLE: { key: SortMode; i18n: string }[] = [
  { key: "name", i18n: "name" },
  { key: "price", i18n: "price" },
];

/** Providers that have arena ranking data */
const ARENA_PROVIDERS = new Set<string | null>(["openyak"]);

/**
 * Variant keywords that disambiguate OpenYak's own model tiers
 * (Fast / Heavy / Heavy Reasoning, etc.). Order matters: longer multi-word
 * variants are matched before single-word ones.
 *
 * Intentionally narrow — we only run variant detection for providers where
 * we own the naming scheme. Third-party brand names like "GLM 4.5 Air",
 * "Gemini 2.5 Flash", "Phi-3 Mini" use these words as part of the family
 * identity rather than as a tier, and substring matching there would split
 * legitimate brand names and collide otherwise-distinct models in the UI.
 */
const VARIANT_KEYWORDS = [
  "Heavy Reasoning",
  "Fast Reasoning",
  "Heavy",
  "Fast",
];

/** Providers whose model names use the OpenYak Fast/Heavy variant scheme. */
const VARIANT_AWARE_PROVIDERS = new Set<string | null>(["openyak"]);

/**
 * Splits a model display name into {family, variant}. Only attempts variant
 * detection when the active provider is known to use the Fast/Heavy scheme;
 * otherwise returns the trimmed name as family with no variant.
 */
function splitModelDisplayName(
  name: string,
  provider: string | null,
): { family: string; variant: string | null } {
  const trimmed = name.trim();
  if (!VARIANT_AWARE_PROVIDERS.has(provider)) {
    return { family: trimmed, variant: null };
  }
  for (const kw of VARIANT_KEYWORDS) {
    // Match keyword as a trailing token (case-insensitive, optional separators).
    const re = new RegExp(`[\\s\\-_·]+${kw}\\s*$`, "i");
    const match = trimmed.match(re);
    if (match) {
      const family = trimmed.slice(0, match.index).trim();
      if (family.length > 0) {
        return { family, variant: kw };
      }
    }
  }
  return { family: trimmed, variant: null };
}

function preserveModelSuffix(name: string, max = 42): string {
  if (name.length <= max) return name;
  const head = Math.max(12, Math.floor(max * 0.55));
  const tail = Math.max(12, max - head - 1);
  return `${name.slice(0, head).trimEnd()}…${name.slice(-tail).trimStart()}`;
}

export function HeaderModelDropdown() {
  const { t } = useTranslation("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: models, isLoading, isError, activeProvider } = useProviderModels();
  const hasArena = ARENA_PROVIDERS.has(activeProvider);
  const [sortBy, setSortBy] = useState<SortMode>(hasArena ? "popular" : "name");
  const { selectedModel, selectedProviderId, setSelectedModel } = useSettingsStore();
  const sortButtons = hasArena ? SORT_BUTTONS_FULL : SORT_BUTTONS_SIMPLE;
  // Reset sort mode when switching between providers with/without arena data
  useEffect(() => {
    setSortBy(hasArena ? "popular" : "name");
  }, [hasArena]);
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
    const modelExists = selectedModel && visibleModels.some((m) => m.id === selectedModel && m.provider_id === selectedProviderId);
    if (!modelExists) {
      let chosen: ModelInfo;
      if (activeProvider === "openyak") {
        const preferred = visibleModels.find((m) => m.id === "openyak/best-free");
        const fallback = visibleModels.find((m) => isFreeModel(m));
        chosen = preferred ?? fallback ?? visibleModels[0];
      } else if (activeProvider === "chatgpt") {
        // Prefer the newest flagship (5.5), fall back to 5.4 if the user's
        // subscription tier hasn't rolled it out yet, then to whatever the
        // backend did return.
        const preferred =
          visibleModels.find((m) => m.id === "openai-subscription/gpt-5.5") ??
          visibleModels.find((m) => m.id === "openai-subscription/gpt-5.4");
        chosen = preferred ?? visibleModels[0];
      } else {
        chosen = visibleModels[0];
      }
      setSelectedModel(chosen.id, chosen.provider_id);
    }
  }, [visibleModels, selectedModel, selectedProviderId, setSelectedModel, activeProvider]);

  const { pinnedModel, freeModels, paidModels } = useMemo(() => {
    if (visibleModels.length === 0) return { pinnedModel: null, freeModels: [], paidModels: [] };

    let pinned: ModelInfo | null = null;
    const free: ModelInfo[] = [];
    const paid: ModelInfo[] = [];
    const isSubscription = activeProvider === "chatgpt";

    for (const m of visibleModels) {
      if (m.id === "openyak/best-free" && activeProvider === "openyak") pinned = m;
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
        // Name sort: reverse natural order — higher version numbers first (newer)
        return b.name.localeCompare(a.name, undefined, { numeric: true });
      };

      free.sort(makeSortFn());
      paid.sort(makeSortFn());
    }

    return { pinnedModel: pinned, freeModels: free, paidModels: paid };
  }, [visibleModels, sortBy, arenaMap, activeProvider]);

  const selectedInfo = visibleModels.find((m) => m.id === selectedModel && m.provider_id === selectedProviderId)
    ?? visibleModels.find((m) => m.id === selectedModel);
  const selectedLabel = selectedInfo?.name ?? (selectedModel ? (selectedModel.includes("/") ? selectedModel.split("/").pop() ?? selectedModel : selectedModel) : t("noModelFound"));
  const shortModel = preserveModelSuffix(selectedLabel);

  // Models still loading with an active provider — show loading indicator
  if (isLoading && activeProvider) {
    return (
      <button
        type="button"
        disabled
        className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg border-none bg-transparent px-3 text-[13px] font-semibold text-[var(--text-tertiary)] shadow-none focus:outline-none cursor-default"
      >
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span className="truncate">{t("loadingModels", "Loading models...")}</span>
      </button>
    );
  }

  if (isError && activeProvider) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => router.push("/settings?tab=providers")}
              className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg border-none bg-transparent px-3 text-[13px] font-semibold text-[var(--text-secondary)] shadow-none transition-colors hover:bg-[var(--surface-secondary)] focus:outline-none cursor-pointer"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-[var(--color-destructive)]" />
              <span className="truncate">{t("modelsUnavailable", "Models unavailable")}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("modelsUnavailableHint", "Check your provider connection, firewall, or VPN settings.")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // No models available — clicking navigates to provider settings instead of opening dropdown
  if (noModels) {
    return (
      <button
        type="button"
        onClick={() => router.push("/settings?tab=providers")}
        className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg border-none bg-transparent px-3 text-[13px] font-semibold text-[var(--text-secondary)] shadow-none transition-colors hover:bg-[var(--surface-secondary)] focus:outline-none cursor-pointer"
      >
        <span className="truncate">{t("setupProvider")}</span>
        <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
      </button>
    );
  }

  const { family: modelFamily, variant: modelVariant } = splitModelDisplayName(
    selectedLabel,
    activeProvider,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            modelVariant ? `${modelFamily} (${modelVariant})` : modelFamily
          }
          title={selectedLabel}
          className={cn(
            "inline-flex translate-y-[1px] items-center gap-1.5 rounded-lg border-none bg-transparent px-3 shadow-none transition-colors hover:bg-[var(--surface-secondary)] focus:outline-none cursor-pointer",
            // Two-line layout when a variant is detected; otherwise keep single
            // line so the visual matches the existing dropdown trigger height.
            modelVariant
              ? "h-10 max-w-[320px] sm:max-w-[420px] py-1"
              : "h-7 max-w-[320px] sm:max-w-[420px] text-[13px] font-semibold text-[var(--text-primary)]",
          )}
        >
          {modelVariant ? (
            <span className="flex flex-col items-start min-w-0 leading-tight">
              <span className="truncate max-w-full text-[13px] font-semibold text-[var(--text-primary)]">
                {modelFamily}
              </span>
              <span className="truncate max-w-full text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                {modelVariant}
              </span>
            </span>
          ) : (
            <span className="truncate">{shortModel}</span>
          )}
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(520px,calc(100vw-24px))] p-0 overflow-hidden" align="start" sideOffset={4}>
        <TooltipProvider delayDuration={300}>
          <Command>
            <CommandInput placeholder={t("searchModels")} />
            {/* Sort bar */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border-default)]">
              <span className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider mr-auto">
                {t("sortBy")}
              </span>
              {sortButtons.map(({ key, i18n }) => (
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
                          setSelectedModel(pinnedModel.id, pinnedModel.provider_id);
                          setOpen(false);
                        }}
                        className="text-sm"
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4 shrink-0",
                            selectedModel === pinnedModel.id && selectedProviderId === pinnedModel.provider_id ? "opacity-100" : "opacity-0",
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
                          key={`${model.provider_id}/${model.id}`}
                          model={model}
                          isSelected={selectedModel === model.id && selectedProviderId === model.provider_id}
                          arena={arenaMap.get(model.id)}
                          sortBy={sortBy}
                          onSelect={() => {
                            setSelectedModel(model.id, model.provider_id);
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
                          key={`${model.provider_id}/${model.id}`}
                          model={model}
                          isSelected={selectedModel === model.id && selectedProviderId === model.provider_id}
                          arena={arenaMap.get(model.id)}
                          sortBy={sortBy}
                          onSelect={() => {
                            setSelectedModel(model.id, model.provider_id);
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

  const providerLabel = PROVIDER_LABELS[model.provider_id] ?? model.provider_id;
  const showProviderBadge = model.provider_id !== "openrouter" && model.provider_id !== "openai-subscription" && model.provider_id !== "ollama";

  return (
    <CommandItem
      value={`${model.name} ${providerLabel}`}
      onSelect={onSelect}
      className="text-sm"
      title={`${model.name} (${model.id})`}
    >
      <Check
        className={cn(
          "mr-2 h-4 w-4 shrink-0",
          isSelected ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{model.name}</span>
        {model.id !== model.name && (
          <span className="block truncate text-[10px] font-normal text-[var(--text-tertiary)]">
            {model.id}
          </span>
        )}
      </span>
      {showProviderBadge && (
        <span className="ml-1.5 shrink-0 text-[9px] font-medium text-[var(--text-tertiary)] bg-[var(--surface-tertiary)] px-1 py-0.5 rounded">
          {providerLabel}
        </span>
      )}
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
