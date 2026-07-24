"use client";

import { useId, useState } from "react";
import Image from "next/image";
import { FileText, Link2 } from "lucide-react";
import { useArtifactStore } from "@/stores/artifact-store";
import {
  canonicalizeExternalSourceUrl,
  type Source,
} from "@/lib/sources";
import type { EvidenceOrigin } from "@/types/subagent";
import type { SummaryInput } from "./workspace-summary-data";

const INITIAL_VISIBLE_ITEMS = 5;

function describeOrigins(origins: EvidenceOrigin[]): string | null {
  if (origins.length === 0) return null;
  return `Origins: ${origins
    .map((origin) =>
      [
        origin.agentTitle,
        `agent ${origin.agent}`,
        `session ${origin.sessionId}`,
        origin.agentRunId ? `run ${origin.agentRunId}` : null,
        origin.status,
        `via ${origin.source}`,
        origin.tool ? `using ${origin.tool}` : "tool unavailable",
      ]
        .filter(Boolean)
        .join(", "),
    )
    .join("; ")}`;
}

function sourceMetadata(source: Source): string {
  const origins = source.origins ?? [];
  const childOrigin = origins.find((origin) => origin.source !== "parent");
  if (!childOrigin) return source.domain;
  return [
    source.domain,
    origins.length > 1 ? `${origins.length} origins` : null,
    childOrigin.agentTitle,
    childOrigin.status,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

interface SummarySectionProps {
  title: string;
  count: number;
  children: React.ReactNode;
}

function SummarySection({
  title,
  count,
  children,
}: SummarySectionProps) {
  return (
    <section
      className="border-t border-[var(--border-subtle)] py-3"
      aria-label={`${title}, ${count}`}
    >
      <div className="flex items-center justify-between px-4 pb-1.5">
        <h2 className="text-base font-normal text-[var(--text-tertiary)]">
          {title}
        </h2>
        <span
          className="text-xs tabular-nums text-[var(--text-quaternary)]"
          aria-hidden="true"
        >
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

export function SourcesSection({ sources }: { sources: Source[] }) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();

  if (sources.length === 0) return null;

  const visibleSources = showAll
    ? sources
    : sources.slice(0, INITIAL_VISIBLE_ITEMS);
  const hasOverflow = sources.length > INITIAL_VISIBLE_ITEMS;

  return (
    <SummarySection title="Sources" count={sources.length}>
      <div id={listId} className="space-y-0.5 px-2">
        {visibleSources.map((source) => {
          const origins = source.origins ?? [];
          const lineage = describeOrigins(origins);
          const canonicalUrl = canonicalizeExternalSourceUrl(source.url);
          const canonicalFavicon = source.favicon
            ? canonicalizeExternalSourceUrl(source.favicon)
            : null;
          const label = lineage
            ? `${source.title}. ${source.domain}. ${lineage}`
            : `${source.title}. ${source.domain}`;
          const title = lineage
            ? canonicalUrl
              ? `${source.title} — ${canonicalUrl} — ${lineage}`
              : `${source.title} — External link unavailable — ${lineage}`
            : canonicalUrl
              ? `${source.title} — ${canonicalUrl}`
              : `${source.title} — External link unavailable`;
          const content = (
            <>
            {canonicalFavicon ? (
              <Image
                src={canonicalFavicon}
                alt=""
                width={16}
                height={16}
                unoptimized
                className="size-4 shrink-0 rounded-sm"
              />
            ) : (
              <Link2
                className="size-4 shrink-0 text-[var(--text-tertiary)]"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-5 text-[var(--text-primary)]">
                {source.title}
              </span>
              <span className="block truncate text-[11px] text-[var(--text-tertiary)]">
                {sourceMetadata(source)}
              </span>
            </span>
            </>
          );
          const className =
            "group flex min-h-9 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-tertiary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ring)]";

          return canonicalUrl ? (
            <a
              key={source.url}
              href={canonicalUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={title}
              aria-label={label}
              className={className}
            >
              {content}
            </a>
          ) : (
            <div
              key={source.url}
              title={title}
              aria-label={label}
              className={className}
            >
              {content}
            </div>
          );
        })}
      </div>
      {hasOverflow && (
        <button
          type="button"
          className="mx-4 mt-1 rounded-md py-1 text-[13px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          onClick={() => setShowAll((current) => !current)}
          aria-expanded={showAll}
          aria-controls={listId}
        >
          {showAll ? "Show less" : `View all ${sources.length}`}
        </button>
      )}
    </SummarySection>
  );
}

export function InputsSection({ inputs }: { inputs: SummaryInput[] }) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();

  if (inputs.length === 0) return null;

  const visibleInputs = showAll
    ? inputs
    : inputs.slice(0, INITIAL_VISIBLE_ITEMS);
  const hiddenCount = inputs.length - visibleInputs.length;

  const openInput = (input: SummaryInput) => {
    useArtifactStore.getState().openArtifact({
      id: `task-input-${input.id}`,
      type: "file-preview",
      title: input.name,
      content: "",
      filePath: input.path,
    });
  };

  return (
    <SummarySection title="Inputs" count={inputs.length}>
      <div id={listId} className="space-y-0.5 px-2">
        {visibleInputs.map((input) => (
          <button
            key={`${input.id}-${input.path}`}
            type="button"
            onClick={() => openInput(input)}
            title={input.path}
            className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-tertiary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
            aria-label={`Open input ${input.name}`}
          >
            <FileText
              className="size-4 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-5 text-[var(--text-primary)]">
                {input.name}
              </span>
              <span className="block text-[11px] capitalize text-[var(--text-tertiary)]">
                {input.source}
              </span>
            </span>
          </button>
        ))}
      </div>
      {inputs.length > INITIAL_VISIBLE_ITEMS && (
        <button
          type="button"
          className="mx-4 mt-1 rounded-md py-1 text-[13px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          onClick={() => setShowAll((current) => !current)}
          aria-expanded={showAll}
          aria-controls={listId}
        >
          {showAll ? "Show less" : `Show ${hiddenCount} more`}
        </button>
      )}
    </SummarySection>
  );
}
