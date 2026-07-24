/**
 * Rich previews should only mount once their source is stable. Rendering an
 * incomplete Mermaid graph on every token produces visible loading/error
 * flashes and repeatedly invokes the expensive diagram renderer.
 */
export function shouldRenderCodeBlockAsSource(
  language: string,
  isStreaming: boolean,
): boolean {
  return isStreaming && language.toLowerCase() === "mermaid";
}
