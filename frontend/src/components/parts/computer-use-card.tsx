"use client";

import { Globe2, MonitorUp } from "lucide-react";
import type { ToolPart } from "@/types/message";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";
import { useComputerWorkspaceStore } from "@/stores/computer-workspace-store";

export function ComputerUseCard({ data }: { data: ToolPart }) {
  const metadata = (data.state.metadata ?? {}) as Record<string, unknown>;
  const image = typeof metadata.image_data_url === "string" ? metadata.image_data_url : null;
  const application =
    typeof metadata.application === "string"
      ? metadata.application
      : typeof metadata.title === "string"
        ? metadata.title
        : "Managed Browser";
  const action = typeof metadata.action === "string" ? metadata.action.replaceAll("_", " ") : "state";
  const width = typeof metadata.image_width === "number" ? metadata.image_width : null;
  const height = typeof metadata.image_height === "number" ? metadata.image_height : null;
  const isBrowser = data.tool === "browser" || metadata.surface === "browser";
  const tabId = typeof metadata.tab_id === "string" ? metadata.tab_id : null;
  const openBrowser = useBrowserWorkspaceStore((state) => state.open);
  const closeBrowser = useBrowserWorkspaceStore((state) => state.close);
  const openComputer = useComputerWorkspaceStore((state) => state.open);
  const closeComputer = useComputerWorkspaceStore((state) => state.close);
  const Icon = isBrowser ? Globe2 : MonitorUp;

  if (!image) return null;

  return (
    <figure className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] shadow-[var(--shadow-sm)]">
      {/* Screenshots are local data URLs produced by the desktop runtime. */}
      {isBrowser ? (
        <button
          type="button"
          onClick={() => { closeComputer(); openBrowser(tabId); }}
          className="block w-full cursor-pointer bg-black outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
          aria-label={`Open live Browser for ${application}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image}
            alt={`Latest OpenYak browser observation of ${application}`}
            className="block h-auto w-full object-contain"
          />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            closeBrowser();
            openComputer(
              typeof metadata.application_id === "string"
                ? metadata.application_id
                : application,
            );
          }}
          className="block w-full cursor-pointer bg-black outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
          aria-label={`Open live Computer for ${application}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image}
            alt={`Latest OpenYak computer-use observation of ${application}`}
            className="block h-auto w-full object-contain"
          />
        </button>
      )}
      <figcaption className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)]">
        <Icon className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
        <span className="font-medium text-[var(--text-primary)]">{application}</span>
        <span className="capitalize">{action}</span>
        <span className="text-[var(--brand-primary)]">
          {isBrowser ? "Open live Browser" : "Open live Computer"}
        </span>
        {width && height ? (
          <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">
            {width}×{height}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
