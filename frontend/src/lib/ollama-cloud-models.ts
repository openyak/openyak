/**
 * Whether a model name explicitly selects Ollama-hosted inference.
 *
 * Ollama uses both `model:cloud` and parameterized tags such as
 * `model:120b-cloud`. Keep this check aligned with the backend guard: Ollama
 * is presented as a local-only provider in OpenYak, so cloud-tagged requests
 * must not silently cross that privacy boundary.
 */
export function isOllamaCloudModelTag(name: string): boolean {
  const leaf = name.trim().split("/").at(-1)?.toLowerCase() ?? "";
  const separator = leaf.lastIndexOf(":");
  if (separator < 0) return false;

  const tag = leaf.slice(separator + 1);
  return tag === "cloud" || tag.endsWith("-cloud");
}

export function getOllamaCloudModelMessage(name: string): string {
  const modelName = name.trim();
  return (
    `${modelName} is hosted by Ollama Cloud, while OpenYak currently treats ` +
    "Ollama as a local-only provider. To use this model directly, run " +
    `\"ollama signin\" and then \"ollama run ${modelName}\" in a terminal. ` +
    "In OpenYak, choose a local tag or use ChatGPT / OpenRouter in Settings → Providers."
  );
}
