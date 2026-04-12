/**
 * Hardcoded model ranking data from OpenRouter.
 * Source: openrouter.ai/rankings (LLM Leaderboard) & openrouter.ai/benchmarks (Intelligence Index)
 * Last updated: April 2026
 */

import { useMemo } from "react";
import type { ModelInfo } from "@/types/model";

export interface ArenaScore {
  arenaScore: number; // Intelligence Index Score (0 = unranked)
  popularityRank: number; // 1 = most popular, 0 = unranked
}

interface RankingEntry {
  name: string;
  score: number;
  rank: number;
}

// Merged data from OpenRouter Benchmarks (Intelligence Index) & LLM Leaderboard (Popularity)
const RANKING_DATA: RankingEntry[] = [
  // Both quality and popularity
  { name: "Gemini 3.1 Pro Preview", score: 57.2, rank: 0 },
  { name: "Claude Opus 4.6", score: 53.0, rank: 7 },
  { name: "Claude Sonnet 4.6", score: 51.7, rank: 6 },
  { name: "GLM 5", score: 49.8, rank: 18 },
  { name: "MiMo V2 Pro", score: 49.2, rank: 1 },
  { name: "MiniMax M2.7", score: 49.6, rank: 9 },
  { name: "MiniMax M2.5", score: 0, rank: 5 },
  { name: "Kimi K2.5", score: 46.8, rank: 12 },
  { name: "Gemini 3 Flash Preview", score: 46.4, rank: 8 },
  { name: "GLM 5 Turbo", score: 46.8, rank: 10 },
  { name: "Qwen3.6 Plus", score: 50.0, rank: 2 },
  { name: "GPT-5.4", score: 56.8, rank: 20 },
  { name: "Gemini 2.5 Flash", score: 0, rank: 13 },
  { name: "Gemini 2.5 Flash Lite", score: 0, rank: 15 },
  { name: "Grok 4.1 Fast", score: 0, rank: 11 },
  { name: "GPT-OSS 120B", score: 0, rank: 16 },
  { name: "Nemotron 3 Super", score: 0, rank: 14 },
  { name: "Hunter Alpha", score: 0, rank: 19 },
  // Quality only
  { name: "GPT-5.3 Codex", score: 53.6, rank: 0 },
  { name: "GLM 5.1", score: 51.4, rank: 0 },
  { name: "Claude Opus 4.5", score: 49.7, rank: 0 },
  { name: "Grok 4.20", score: 48.5, rank: 0 },
  { name: "Gemini 3 Pro Preview", score: 48.4, rank: 0 },
  { name: "GPT-5.4 mini", score: 48.9, rank: 0 },
  { name: "GPT-5.1", score: 47.7, rank: 0 },
  { name: "Qwen3.5 397B A17B", score: 45.0, rank: 0 },
  // Popularity only
  { name: "Step 3.5 Flash", score: 0, rank: 3 },
  { name: "DeepSeek V3.2", score: 0, rank: 4 },
  { name: "Qwen3.6 Plus Preview", score: 0, rank: 17 },
];

/** Normalize a model name for fuzzy matching. */
function normalize(name: string): string {
  let n = name.toLowerCase();
  // Strip provider prefix ("Google: ", "OpenAI: ", etc.)
  const colon = n.indexOf(":");
  if (colon > 0 && colon < 20) n = n.slice(colon + 1);
  // Remove parenthesized content — "(free)", "(20250514)", etc.
  n = n.replace(/\(.*?\)/g, "");
  // Remove full date patterns: YYYY-MM-DD, YYYYMMDD
  n = n.replace(/\d{4}[-.]?\d{2}[-.]?\d{2}/g, "");
  // Remove common noise words
  n = n.replace(/\b(preview|beta|latest|exp|experimental|chat|free)\b/g, "");
  // Collapse all separators and whitespace
  n = n.replace(/[\s\-_.]+/g, "");
  // Remove trailing short date digits (MMDD like 0324, 0506)
  n = n.replace(/\d{3,4}$/, "");
  return n.trim();
}

// Pre-build the normalized map at module level
const ARENA_MAP: Map<string, ArenaScore> = (() => {
  const map = new Map<string, ArenaScore>();
  for (const entry of RANKING_DATA) {
    const key = normalize(entry.name);
    if (key) {
      map.set(key, {
        arenaScore: entry.score,
        popularityRank: entry.rank,
      });
    }
  }
  return map;
})();

/** Returns hardcoded ranking data (no network fetch). */
export function useArenaScores() {
  return { data: ARENA_MAP };
}

/**
 * Build a lookup from OpenRouter model ID → ArenaScore.
 * Tries normalized name matching between ranking entries and OpenRouter models.
 */
export function useModelArenaMap(models: ModelInfo[] | undefined) {
  const { data: arenaMap } = useArenaScores();

  return useMemo(() => {
    const result = new Map<string, ArenaScore>();
    if (!models || !arenaMap) return result;

    const arenaEntries = Array.from(arenaMap.entries());

    for (const model of models) {
      const key = normalize(model.name);
      if (!key) continue;

      // 1. Exact normalized match
      const exact = arenaMap.get(key);
      if (exact) {
        result.set(model.id, exact);
        continue;
      }

      // 2. Fallback: find entry where one contains the other
      let best: ArenaScore | undefined;
      let bestLen = 0;
      for (const [arenaKey, score] of arenaEntries) {
        if (arenaKey.length < 4) continue;
        if (key.includes(arenaKey) || arenaKey.includes(key)) {
          const matchLen = Math.min(key.length, arenaKey.length);
          if (matchLen > bestLen) {
            bestLen = matchLen;
            best = score;
          }
        }
      }
      if (best && bestLen >= 6) {
        result.set(model.id, best);
      }
    }
    return result;
  }, [models, arenaMap]);
}
