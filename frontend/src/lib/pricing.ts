/** Pricing utilities for model selector UI.
 *  No markup — prices match OpenRouter exactly. */

/** Convert USD-per-million-tokens for display (no markup). */
export function usdToCentsPerM(usdPerM: number): number {
  if (usdPerM <= 0) return 0;
  return Math.ceil(usdPerM * 100);
}

/** Format $/M for display. Returns e.g. "$3.00/M", "$0.25/M", or "FREE". */
export function formatUsdPerM(centsPerM: number): string {
  if (centsPerM === 0) return "FREE";
  const usd = centsPerM / 100;
  if (usd >= 1) return `$${usd.toFixed(2)}/M`;
  return `$${usd.toFixed(usd >= 0.1 ? 2 : 3)}/M`;
}
