/**
 * Single source of truth for mapping a model's `provider_id` to the
 * `activeProvider` UI bucket that surfaces it in the model dropdown.
 *
 * This decision table used to be hand-rolled (and mutually inverted) in
 * several places — the dropdown's model filter, the settings provider picker,
 * and the per-session model-restore hook. Keep it here so a new bucket can't
 * silently drift out of sync across them.
 */

import type { ActiveProvider } from "@/stores/settings-store";

/** A concrete provider bucket (the non-null `ActiveProvider` values). */
export type ProviderBucket = Exclude<ActiveProvider, null>;

/** Which dropdown bucket a model's `provider_id` belongs to. */
export function providerBucket(providerId: string): ProviderBucket {
  if (providerId === "openai-subscription") return "chatgpt";
  if (providerId === "ollama") return "ollama";
  if (providerId === "rapid-mlx") return "rapid-mlx";
  if (providerId === "local" || providerId.startsWith("custom_")) return "custom";
  return "byok";
}

/** True for direct BYOK providers (everything not subscription/ollama/mlx/custom). */
export function isByokProviderId(providerId: string | undefined): boolean {
  return !!providerId && providerBucket(providerId) === "byok";
}

/** True for custom OpenAI-compatible endpoints (`local` or `custom_*`). */
export function isCustomEndpointProviderId(providerId: string | undefined): boolean {
  return !!providerId && providerBucket(providerId) === "custom";
}
