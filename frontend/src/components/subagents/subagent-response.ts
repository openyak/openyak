import type { PartData } from "@/types/message";

interface ComposeSubagentResponseInput {
  persistedText: string;
  streamingParts: PartData[];
  streamingText: string;
}

const RESPONSE_SEPARATOR = "\n\n";

function mergeResponseText(persisted: string, live: string): string {
  if (!persisted) return live;
  if (!live) return persisted;
  if (live.startsWith(persisted)) return live;
  if (persisted.startsWith(live) || persisted.endsWith(live)) {
    return persisted;
  }

  const persistedSteps = persisted.split(RESPONSE_SEPARATOR);
  const liveSteps = live.split(RESPONSE_SEPARATOR);
  for (
    let overlap = Math.min(persistedSteps.length, liveSteps.length);
    overlap > 0;
    overlap -= 1
  ) {
    if (
      persistedSteps.slice(-overlap).every(
        (step, index) => step === liveSteps[index],
      )
    ) {
      return [
        ...persistedSteps,
        ...liveSteps.slice(overlap),
      ].join(RESPONSE_SEPARATOR);
    }
  }

  return `${persisted}${RESPONSE_SEPARATOR}${live}`;
}

export function composeSubagentResponse({
  persistedText,
  streamingParts,
  streamingText,
}: ComposeSubagentResponseInput): string {
  const persisted = persistedText.trim();
  const liveSegments = [
    ...streamingParts.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    ),
    streamingText,
  ]
    .map((text) => text.trim())
    .filter(Boolean);

  const live = liveSegments.reduce(
    (response, segment) =>
      response === segment
        ? response
        : [response, segment].filter(Boolean).join(RESPONSE_SEPARATOR),
    "",
  );

  return mergeResponseText(persisted, live);
}
