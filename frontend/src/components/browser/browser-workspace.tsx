"use client";

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  LoaderCircle,
  MousePointer2,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, apiErrorMessage } from "@/lib/api";
import { API } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";

type ControlOwner = "agent" | "user";

interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

interface BrowserStatus {
  control_owner: ControlOwner;
  tabs: BrowserTab[];
}

interface BrowserSnapshot {
  tab_id: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  image_data_url: string | null;
}

function displayUrl(url: string): string {
  return url === "about:blank" ? "" : url;
}

function navigableUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "https://www.google.com";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function BrowserWorkspace() {
  const { t } = useTranslation("chat");
  const activeTabId = useBrowserWorkspaceStore((state) => state.activeTabId);
  const selectTab = useBrowserWorkspaceStore((state) => state.selectTab);
  const closeWorkspace = useBrowserWorkspaceStore((state) => state.close);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [address, setAddress] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotRequest = useRef(false);
  const addressEditing = useRef(false);
  const scrollDelta = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.get<BrowserStatus>(API.BROWSER_CONTROL.STATUS, {
        timeoutMs: 10_000,
      });
      setStatus(next);
      setError(null);
      const currentStillExists = next.tabs.some((tab) => tab.id === activeTabId);
      const nextActive = currentStillExists ? activeTabId : next.tabs.at(-1)?.id;
      if (nextActive && nextActive !== activeTabId) selectTab(nextActive);
    } catch (reason) {
      setError(apiErrorMessage(reason, t("browserUnavailable")));
    }
  }, [activeTabId, selectTab, t]);

  const refreshSnapshot = useCallback(async () => {
    if (!activeTabId || snapshotRequest.current) return;
    snapshotRequest.current = true;
    try {
      const next = await api.get<BrowserSnapshot>(
        API.BROWSER_CONTROL.SNAPSHOT(activeTabId),
        { timeoutMs: 10_000 },
      );
      setSnapshot(next);
      if (!addressEditing.current) setAddress(displayUrl(next.url));
      setError(null);
    } catch (reason) {
      setError(apiErrorMessage(reason, t("browserFrameUnavailable")));
    } finally {
      snapshotRequest.current = false;
    }
  }, [activeTabId, t]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1_500);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    setSnapshot(null);
    if (!activeTabId) return;
    void refreshSnapshot();
    const timer = window.setInterval(() => void refreshSnapshot(), 900);
    return () => window.clearInterval(timer);
  }, [activeTabId, refreshSnapshot]);

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  const setOwner = useCallback(async (owner: ControlOwner) => {
    const next = await api.post<{ control_owner: ControlOwner }>(
      API.BROWSER_CONTROL.CONTROL,
      { owner },
    );
    setStatus((current) => current ? { ...current, control_owner: next.control_owner } : current);
  }, []);

  const interact = useCallback(async (
    action: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (status?.control_owner !== "user") await setOwner("user");
    return api.post<Record<string, unknown>>(API.BROWSER_CONTROL.INTERACT, {
      action,
      ...payload,
    });
  }, [setOwner, status?.control_owner]);

  const runInteraction = useCallback(async (
    action: string,
    payload: Record<string, unknown> = {},
  ) => {
    setIsBusy(true);
    try {
      const result = await interact(action, payload);
      await refreshStatus();
      await refreshSnapshot();
      return result;
    } catch (reason) {
      toast.error(apiErrorMessage(reason, t("browserActionFailed")));
      return null;
    } finally {
      setIsBusy(false);
    }
  }, [interact, refreshSnapshot, refreshStatus, t]);

  const goToAddress = () => {
    if (!activeTabId) return;
    void runInteraction("navigate", { tab_id: activeTabId, url: navigableUrl(address) });
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    goToAddress();
  };

  const newTab = async () => {
    const result = await runInteraction("new_tab");
    if (typeof result?.tab_id === "string") selectTab(result.tab_id);
  };

  const closeTab = async (tabId: string) => {
    await runInteraction("close_tab", { tab_id: tabId });
  };

  const clickFrame = (event: MouseEvent<HTMLButtonElement>) => {
    if (!activeTabId || !snapshot?.viewport) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * snapshot.viewport.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * snapshot.viewport.height;
    void runInteraction("click", { tab_id: activeTabId, x, y });
  };

  const keyFrame = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!activeTabId || event.key === "Tab") return;
    event.preventDefault();
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      void runInteraction("type", { tab_id: activeTabId, text: event.key });
      return;
    }
    const modifiers = [
      event.metaKey ? "Meta" : null,
      event.ctrlKey ? "Control" : null,
      event.altKey ? "Alt" : null,
      event.shiftKey ? "Shift" : null,
    ].filter(Boolean);
    const key = event.key === " " ? "Space" : event.key;
    void runInteraction("key", { tab_id: activeTabId, key: [...modifiers, key].join("+") });
  };

  const wheelFrame = (event: WheelEvent<HTMLButtonElement>) => {
    if (!activeTabId) return;
    event.preventDefault();
    scrollDelta.current += event.deltaY;
    if (scrollTimer.current) return;
    scrollTimer.current = setTimeout(() => {
      const deltaY = Math.round(scrollDelta.current);
      scrollDelta.current = 0;
      scrollTimer.current = null;
      void runInteraction("scroll", { tab_id: activeTabId, delta_y: deltaY });
    }, 100);
  };

  const owner = status?.control_owner ?? "agent";
  const tabs = status?.tabs ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--surface-primary)]">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border-default)] px-2">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "group flex min-w-0 max-w-48 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
              tab.id === activeTabId
                ? "bg-[var(--surface-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]",
            )}
          >
            <button
              type="button"
              onClick={() => selectTab(tab.id)}
              className="min-w-0 flex-1 truncate text-left outline-none"
            >
              {tab.title || t("browserNewTab")}
            </button>
            <button
              type="button"
              aria-label={t("browserCloseTab")}
              onClick={(event) => { event.stopPropagation(); void closeTab(tab.id); }}
              className="rounded p-0.5 opacity-0 hover:bg-[var(--surface-primary)] group-hover:opacity-100 focus:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => void newTab()} aria-label={t("browserNewTab")} className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={closeWorkspace} aria-label={t("browserCloseWorkspace")} className="ml-auto rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-default)] px-2 py-1.5">
        <button type="button" disabled={!activeTabId || isBusy} onClick={() => void runInteraction("back", { tab_id: activeTabId })} aria-label={t("browserBack")} className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] disabled:opacity-35"><ArrowLeft className="h-4 w-4" /></button>
        <button type="button" disabled={!activeTabId || isBusy} onClick={() => void runInteraction("forward", { tab_id: activeTabId })} aria-label={t("browserForward")} className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] disabled:opacity-35"><ArrowRight className="h-4 w-4" /></button>
        <button type="button" disabled={!activeTabId || isBusy} onClick={() => void runInteraction("reload", { tab_id: activeTabId })} aria-label={t("browserReload")} className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] disabled:opacity-35"><RefreshCw className={cn("h-4 w-4", isBusy && "animate-spin")} /></button>
        <form onSubmit={submitAddress} className="min-w-0 flex-1">
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => { addressEditing.current = true; }}
            onBlur={() => { addressEditing.current = false; }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              goToAddress();
            }}
            disabled={!activeTabId}
            aria-label={t("browserAddress")}
            placeholder={t("browserAddressPlaceholder")}
            className="h-7 w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--ring)]"
          />
        </form>
        <button
          type="button"
          disabled={!status}
          onClick={() => void setOwner(owner === "agent" ? "user" : "agent")}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:opacity-40",
            owner === "user"
              ? "border-[var(--brand-primary)]/40 bg-[var(--brand-primary)]/10 text-[var(--text-primary)]"
              : "border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]",
          )}
        >
          {owner === "agent" ? <MousePointer2 className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
          {owner === "agent" ? t("browserTakeOver") : t("browserReturnToAgent")}
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#111] p-2">
        {snapshot?.image_data_url ? (
          <button
            type="button"
            onClick={clickFrame}
            onKeyDown={keyFrame}
            onWheel={wheelFrame}
            aria-label={t("browserLiveViewport")}
            className="relative block max-h-full max-w-full cursor-default overflow-hidden rounded-sm outline-none ring-[var(--brand-primary)] focus-visible:ring-2"
            style={{ aspectRatio: `${snapshot.viewport.width} / ${snapshot.viewport.height}` }}
          >
            {/* The managed runtime supplies this local, short-lived frame. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={snapshot.image_data_url} alt={snapshot.title || t("browserLiveViewport")} draggable={false} className="block max-h-full max-w-full object-contain" />
          </button>
        ) : !error ? (
          <LoaderCircle className="h-6 w-6 animate-spin text-white/45" />
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#111]/90 px-8 text-center text-sm text-white/70">
            <span>{error}</span>
            <button type="button" onClick={() => { void refreshStatus(); void refreshSnapshot(); }} className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15"><RotateCcw className="h-3.5 w-3.5" />{t("browserRetry")}</button>
          </div>
        ) : null}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-[var(--border-default)] px-3 text-[11px] text-[var(--text-tertiary)]">
        <span className={cn("h-1.5 w-1.5 rounded-full", owner === "user" ? "bg-[var(--brand-primary)]" : "bg-emerald-500")} />
        <span>{owner === "user" ? t("browserYouControl") : t("browserAgentControls")}</span>
        {snapshot ? <span className="ml-auto truncate">{snapshot.title || snapshot.url}</span> : null}
      </div>
    </div>
  );
}
