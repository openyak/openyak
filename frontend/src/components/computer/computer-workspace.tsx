"use client";

import {
  Bot,
  LoaderCircle,
  MonitorUp,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, apiErrorMessage } from "@/lib/api";
import { API } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useComputerWorkspaceStore } from "@/stores/computer-workspace-store";

type ControlOwner = "agent" | "user";

interface ComputerApplication {
  id: string;
  name: string;
  pid: number;
  is_running: boolean;
}

interface ComputerWorkspaceStatus {
  control_owner: ControlOwner;
  selected_application: string | null;
  applications: ComputerApplication[];
}

interface ComputerSnapshot {
  application: { id: string; name: string; pid: number };
  revision: number;
  image_data_url: string | null;
  frame: {
    image_width: number;
    image_height: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
}

export function ComputerWorkspace() {
  const { t } = useTranslation("chat");
  const applicationId = useComputerWorkspaceStore((state) => state.applicationId);
  const rememberApplication = useComputerWorkspaceStore((state) => state.selectApplication);
  const closeWorkspace = useComputerWorkspaceStore((state) => state.close);
  const [status, setStatus] = useState<ComputerWorkspaceStatus | null>(null);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotRequest = useRef(false);
  const scrollDelta = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectApplication = useCallback(async (nextApplication: string) => {
    setIsBusy(true);
    try {
      await api.post(API.COMPUTER_CONTROL.WORKSPACE_SELECT, {
        application: nextApplication,
      });
      rememberApplication(nextApplication);
      setSnapshot(null);
      setError(null);
    } catch (reason) {
      toast.error(apiErrorMessage(reason, t("computerSwitchFailed")));
    } finally {
      setIsBusy(false);
    }
  }, [rememberApplication, t]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.get<ComputerWorkspaceStatus>(
        API.COMPUTER_CONTROL.WORKSPACE_STATUS,
        { timeoutMs: 10_000 },
      );
      setStatus(next);
      setError(null);
      const rememberedExists = next.applications.some((app) => app.id === applicationId);
      const candidate = rememberedExists
        ? applicationId
        : next.selected_application && next.applications.some(
            (app) => app.id === next.selected_application,
          )
          ? next.selected_application
          : next.applications[0]?.id;
      if (candidate && candidate !== applicationId) rememberApplication(candidate);
      if (candidate && candidate !== next.selected_application) {
        void selectApplication(candidate);
      }
    } catch (reason) {
      setError(apiErrorMessage(reason, t("computerUnavailable")));
    }
  }, [applicationId, rememberApplication, selectApplication, t]);

  const refreshSnapshot = useCallback(async () => {
    if (!applicationId || snapshotRequest.current) return;
    snapshotRequest.current = true;
    try {
      const next = await api.get<ComputerSnapshot>(
        API.COMPUTER_CONTROL.WORKSPACE_SNAPSHOT,
        { timeoutMs: 15_000 },
      );
      if (next.application.id === applicationId) {
        setSnapshot(next);
        setError(null);
      }
    } catch (reason) {
      setError(apiErrorMessage(reason, t("computerFrameUnavailable")));
    } finally {
      snapshotRequest.current = false;
    }
  }, [applicationId, t]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1_500);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    setSnapshot(null);
    if (!applicationId) return;
    void refreshSnapshot();
    const timer = window.setInterval(() => void refreshSnapshot(), 900);
    return () => window.clearInterval(timer);
  }, [applicationId, refreshSnapshot]);

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  const setOwner = useCallback(async (owner: ControlOwner) => {
    try {
      const next = await api.post<{ control_owner: ControlOwner }>(
        API.COMPUTER_CONTROL.WORKSPACE_CONTROL,
        { owner },
      );
      setStatus((current) => current
        ? { ...current, control_owner: next.control_owner }
        : current);
      return true;
    } catch (reason) {
      toast.error(apiErrorMessage(reason, t("computerControlFailed")));
      return false;
    }
  }, [t]);

  const releaseAndClose = useCallback(async () => {
    if (status?.control_owner === "user" && !(await setOwner("agent"))) return;
    closeWorkspace();
  }, [closeWorkspace, setOwner, status?.control_owner]);

  const interact = useCallback(async (payload: Record<string, unknown>) => {
    setIsBusy(true);
    try {
      await api.post(API.COMPUTER_CONTROL.WORKSPACE_INTERACT, payload);
      await refreshSnapshot();
    } catch (reason) {
      toast.error(apiErrorMessage(reason, t("computerActionFailed")));
    } finally {
      setIsBusy(false);
    }
  }, [refreshSnapshot, t]);

  const clickFrame = (event: MouseEvent<HTMLButtonElement>) => {
    if (!snapshot?.frame || status?.control_owner !== "user") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * snapshot.frame.image_width;
    const y = ((event.clientY - bounds.top) / bounds.height) * snapshot.frame.image_height;
    void interact({ action: "click", x, y });
  };

  const keyFrame = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (status?.control_owner !== "user" || event.key === "Tab") return;
    event.preventDefault();
    const modifiers = [
      event.metaKey ? "meta" : null,
      event.ctrlKey ? "control" : null,
      event.altKey ? "alt" : null,
      event.shiftKey ? "shift" : null,
    ].filter((value): value is string => Boolean(value));
    const key = event.key === " " ? "Space" : event.key;
    void interact({ action: "key", key, modifiers });
  };

  const wheelFrame = (event: WheelEvent<HTMLButtonElement>) => {
    if (status?.control_owner !== "user") return;
    event.preventDefault();
    scrollDelta.current += event.deltaY;
    if (scrollTimer.current) return;
    scrollTimer.current = setTimeout(() => {
      const deltaY = Math.round(scrollDelta.current);
      scrollDelta.current = 0;
      scrollTimer.current = null;
      if (deltaY !== 0) void interact({ action: "scroll", delta_y: deltaY });
    }, 100);
  };

  const owner = status?.control_owner ?? "agent";
  const applications = status?.applications ?? [];
  const currentApplication = applications.find((app) => app.id === applicationId);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--surface-primary)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2.5">
        <MonitorUp className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
        <select
          value={applicationId ?? ""}
          onChange={(event) => void selectApplication(event.target.value)}
          disabled={applications.length === 0 || isBusy}
          aria-label={t("computerTargetApplication")}
          className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 text-xs font-medium text-[var(--text-primary)] outline-none focus:border-[var(--ring)]"
        >
          {applications.length === 0 ? (
            <option value="">{t("computerNoApplications")}</option>
          ) : null}
          {applications.map((application) => (
            <option key={application.id} value={application.id}>
              {application.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => { void refreshStatus(); void refreshSnapshot(); }}
          disabled={isBusy}
          aria-label={t("computerRefresh")}
          className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] disabled:opacity-35"
        >
          <RefreshCw className={cn("h-4 w-4", isBusy && "animate-spin")} />
        </button>
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
          {owner === "agent" ? t("computerTakeOver") : t("computerReturnToAgent")}
        </button>
        <button
          type="button"
          onClick={() => void releaseAndClose()}
          aria-label={t("computerCloseWorkspace")}
          className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#101112] p-2">
        {snapshot?.image_data_url && snapshot.frame ? (
          <button
            type="button"
            onClick={clickFrame}
            onKeyDown={keyFrame}
            onWheel={wheelFrame}
            disabled={owner !== "user"}
            aria-label={t("computerLiveViewport")}
            className={cn(
              "relative block w-full max-h-full max-w-full overflow-hidden rounded-sm outline-none ring-[var(--brand-primary)] focus-visible:ring-2",
              owner === "user" ? "cursor-default" : "cursor-not-allowed",
            )}
            style={{
              aspectRatio: `${snapshot.frame.image_width} / ${snapshot.frame.image_height}`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={snapshot.image_data_url}
              alt={t("computerLiveViewOf", { app: snapshot.application.name })}
              draggable={false}
              className="block h-full w-full object-contain"
            />
          </button>
        ) : !error ? (
          <LoaderCircle className="h-6 w-6 animate-spin text-white/45" />
        ) : null}
        {owner === "agent" && snapshot?.image_data_url ? (
          <div className="pointer-events-none absolute bottom-5 rounded-full border border-white/10 bg-black/65 px-3 py-1.5 text-[11px] text-white/75 backdrop-blur">
            {t("computerTakeOverToInteract")}
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#101112]/90 px-8 text-center text-sm text-white/70">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => { void refreshStatus(); void refreshSnapshot(); }}
              className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("computerRetry")}
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-[var(--border-default)] px-3 text-[11px] text-[var(--text-tertiary)]">
        <span className={cn("h-1.5 w-1.5 rounded-full", owner === "user" ? "bg-[var(--brand-primary)]" : "bg-emerald-500")} />
        <span>{owner === "user" ? t("computerYouControl") : t("computerAgentControls")}</span>
        {currentApplication ? (
          <span className="ml-auto truncate">
            {currentApplication.name} · r{snapshot?.revision ?? "—"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
