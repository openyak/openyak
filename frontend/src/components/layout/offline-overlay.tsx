"use client";

import { useState } from "react";
import { WifiOff, RefreshCw, X, QrCode } from "lucide-react";
import { useRouter } from "next/navigation";
import { useConnectionStore } from "@/stores/connection-store";
import { isRemoteMode } from "@/lib/remote-connection";
import { getTaskConnectionStatus } from "@/lib/stream-status";
import { Button } from "@/components/ui/button";

export function OfflineOverlay({ sessionId }: { sessionId?: string }) {
  const status = useConnectionStore((state) =>
    sessionId
      ? getTaskConnectionStatus(state.sessionStates[sessionId])
      : state.status,
  );
  const [dismissed, setDismissed] = useState(false);
  const router = useRouter();

  // Only show when fully disconnected, not during brief reconnection attempts
  if (status !== "disconnected" || dismissed) return null;

  const handleRetry = () => {
    window.location.reload();
  };

  const remote = isRemoteMode();

  return (
    <div className="absolute top-0 inset-x-0 z-20 px-4 pt-[max(env(safe-area-inset-top),8px)]">
      <div className="mx-auto max-w-3xl rounded-xl border border-[var(--color-destructive)]/30 bg-[var(--surface-primary)] shadow-lg backdrop-blur-sm animate-slide-up">
        <div className="flex items-center gap-3 px-4 py-3">
          <WifiOff className="h-4 w-4 text-[var(--color-destructive)] shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Unable to connect
            </p>
            <p className="text-xs text-[var(--text-secondary)] truncate">
              {remote
                ? "Tunnel may have changed. Try reconnecting or rescan QR code."
                : "Make sure the backend server is running."}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={handleRetry}>
              <RefreshCw className="h-3 w-3" />
              Retry
            </Button>
            {remote && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => router.push("/m/settings")}
              >
                <QrCode className="h-3 w-3" />
                Rescan
              </Button>
            )}
            <button
              onClick={() => setDismissed(true)}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-[var(--surface-secondary)] text-[var(--text-tertiary)]"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
