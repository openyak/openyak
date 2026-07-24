"use client";

import { useState } from "react";
import { ChevronUp } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  canonicalizeExternalSourceUrl,
  type Source,
} from "@/lib/sources";

interface SourcesFooterProps {
  sources: Source[];
}

export function SourcesFooter({ sources }: SourcesFooterProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (sources.length === 0) return null;

  const firstFavicon = sources
    .map((source) =>
      source.favicon
        ? canonicalizeExternalSourceUrl(source.favicon)
        : null,
    )
    .find((favicon) => favicon !== null);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        >
          {firstFavicon && (
            <Image
              src={firstFavicon}
              alt=""
              width={14}
              height={14}
              unoptimized
              className="h-3.5 w-3.5 rounded-sm"
              loading="lazy"
            />
          )}
          <span>Sources</span>
          <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--surface-tertiary)] rounded-full px-1.5 py-0.5 leading-none min-w-[18px] text-center">
            {sources.length}
          </span>
          <ChevronUp
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              isOpen && "rotate-180",
            )}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="w-[320px] max-h-[300px] overflow-y-auto p-2 space-y-0.5 scrollbar-auto"
      >
        {sources.map((source) => {
          const safeUrl = canonicalizeExternalSourceUrl(source.url);
          const safeFavicon = source.favicon
            ? canonicalizeExternalSourceUrl(source.favicon)
            : null;
          const content = (
            <>
            {safeFavicon && (
              <Image
                src={safeFavicon}
                alt=""
                width={16}
                height={16}
                unoptimized
                className="h-4 w-4 rounded-sm flex-shrink-0"
                loading="lazy"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{source.title}</div>
              <div className="truncate text-[10px] text-[var(--text-tertiary)]">{source.domain}</div>
            </div>
            </>
          );
          const className =
            "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-[var(--text-secondary)] transition-colors";

          return safeUrl ? (
            <a
              key={source.url}
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                className,
                "hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {content}
            </a>
          ) : (
            <div
              key={source.url}
              className={className}
              aria-label={`${source.title}. Unsafe source URL; link disabled`}
            >
              {content}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
