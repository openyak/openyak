"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Camera, CheckCircle2, XCircle, Loader2,
  Wifi, WifiOff, KeyRound, Link2, Trash2, Eye, Cpu,
} from "lucide-react";
import { toast } from "sonner";
import {
  getRemoteConfig,
  saveRemoteConfig,
  clearRemoteConfig,
  parseQRData,
  autoConnectFromUrl,
  isRemoteMode,
  getRemoteProvider,
  saveRemoteProvider,
  type RemoteConfig,
  type RemoteProvider,
} from "@/lib/remote-connection";
import { api } from "@/lib/api";
import { API } from "@/lib/constants";
import { useSettingsStore } from "@/stores/settings-store";
import type { ModelInfo } from "@/types/model";
import { useChannels, useChannelStatus } from "@/hooks/use-channels";

export default function MobileSettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Provider state
  const [activeProvider, setActiveProvider] = useState<RemoteProvider | null>(null);
  const [availableProviders, setAvailableProviders] = useState<{ id: RemoteProvider; label: string; icon: typeof Cpu; count: number }[]>([]);
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    // Auto-connect from URL token (e.g., pasted link)
    autoConnectFromUrl();

    const existing = getRemoteConfig();
    if (existing) {
      setConfig(existing);
      setUrl(existing.url);
      setToken(existing.token);
    }
    // Load saved provider preference
    const saved = getRemoteProvider();
    if (saved) setActiveProvider(saved);
  }, []);

  // Fetch available providers when connected
  useEffect(() => {
    if (!isRemoteMode()) return;
    api.get<ModelInfo[]>(API.MODELS)
      .then((models) => {
        if (!Array.isArray(models)) return;
        setAllModels(models);
        const providers: typeof availableProviders = [];
        const openrouterModels = models.filter((m) => m.provider_id === "openrouter");
        if (openrouterModels.length > 0) {
          providers.push({ id: "openrouter", label: "OpenRouter", icon: Eye, count: openrouterModels.length });
        }
        setAvailableProviders(providers);
        // Auto-select if no preference saved
        if (!activeProvider && providers.length > 0) {
          setActiveProvider(providers[0].id);
          saveRemoteProvider(providers[0].id);
        }
      })
      .catch(() => {});
  }, [activeProvider, config]);

  const handleProviderSelect = (id: RemoteProvider) => {
    setActiveProvider(id);
    saveRemoteProvider(id);
    // Sync to Zustand so ChatView's ModelSelector filters correctly
    const store = useSettingsStore.getState();
    store.setActiveProvider("byok");
    // Also set selectedModel to first model of this provider
    const firstModel = allModels.find((m) => m.provider_id === "openrouter");
    if (firstModel) {
      store.setSelectedModel(firstModel.id, firstModel.provider_id);
    }
  };

  const handleConnect = useCallback(async (connectUrl: string, connectToken: string) => {
    if (!connectUrl || !connectToken) return;
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch(`${connectUrl}/health`, {
        headers: { Authorization: `Bearer ${connectToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const newConfig = { url: connectUrl, token: connectToken };
        saveRemoteConfig(newConfig);
        setConfig(newConfig);
        setTestResult("success");
        setTimeout(() => router.push("/m"), 800);
      } else {
        setTestResult("error");
        toast.error(res.status === 401 ? "Invalid token" : "Connection failed");
      }
    } catch {
      setTestResult("error");
      toast.error("Cannot reach server. Check the URL.");
    } finally {
      setTesting(false);
    }
  }, [router]);

  const handleDisconnect = useCallback(() => {
    clearRemoteConfig();
    setConfig(null);
    setUrl("");
    setToken("");
    setTestResult(null);
  }, []);

  const stopScan = useCallback(() => {
    setScanning(false);
    scanningRef.current = false;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startScan = useCallback(async () => {
    setScanning(true);
    scanningRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if ("BarcodeDetector" in window) {
        // BarcodeDetector is a browser API not yet in TypeScript's lib definitions
        const detector = new (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector({ formats: ["qr_code"] });
        const scanLoop = async () => {
          if (!videoRef.current || !scanningRef.current) return;
          try {
            const barcodes = await detector.detect(videoRef.current);
            if (barcodes.length > 0) {
              const parsed = parseQRData(barcodes[0].rawValue);
              if (parsed) {
                stopScan();
                setUrl(parsed.url);
                setToken(parsed.token);
                handleConnect(parsed.url, parsed.token);
                return;
              }
            }
          } catch {}
          if (scanningRef.current) requestAnimationFrame(scanLoop);
        };
        requestAnimationFrame(scanLoop);
      } else {
        toast.error("QR scanning not supported on this browser");
        stopScan();
      }
    } catch {
      toast.error("Could not access camera");
      setScanning(false);
      scanningRef.current = false;
    }
  }, [handleConnect, stopScan]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const isConnected = config !== null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3">
        {isRemoteMode() && (
          <button
            onClick={() => router.push("/m")}
            className="h-9 w-9 flex items-center justify-center rounded-full hover:bg-[var(--surface-secondary)] active:scale-[0.95] transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <h1 className="text-lg font-semibold tracking-tight">Connection</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom),16px)] space-y-5">
        {/* Connection status card */}
        <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
          <div className="flex items-center gap-3">
            {isConnected ? (
              <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                <Wifi className="w-5 h-5 text-emerald-500" />
              </div>
            ) : (
              <div className="h-10 w-10 rounded-full bg-[var(--surface-tertiary)] flex items-center justify-center shrink-0">
                <WifiOff className="w-5 h-5 text-[var(--text-tertiary)]" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-medium">
                {isConnected ? "Connected" : "Not connected"}
              </p>
              {isConnected && (
                <p className="text-[12px] text-[var(--text-tertiary)] truncate mt-0.5">
                  {config.url}
                </p>
              )}
            </div>
            {isConnected && (
              <button
                onClick={handleDisconnect}
                className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-red-500/10 text-[var(--text-tertiary)] hover:text-red-400 active:scale-[0.95] transition-all"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* QR Scanner */}
        {!isConnected && (
          <div className="space-y-3">
            <p className="text-[13px] font-medium text-[var(--text-secondary)] px-1">
              Scan QR Code
            </p>

            {scanning ? (
              <div className="relative rounded-2xl overflow-hidden bg-black aspect-square max-w-[280px] mx-auto shadow-[var(--shadow-lg)]">
                <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
                <div className="absolute inset-4 border-2 border-white/20 rounded-xl" />
                <button
                  onClick={stopScan}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 px-5 py-2 rounded-full bg-black/60 backdrop-blur-sm text-white text-[13px] font-medium active:scale-[0.97]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={startScan}
                className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] text-[14px] font-medium active:scale-[0.98] active:bg-[var(--surface-tertiary)] transition-all"
              >
                <Camera className="w-[18px] h-[18px] text-[var(--text-secondary)]" />
                Open Camera
              </button>
            )}
          </div>
        )}

        {/* Manual input */}
        {!isConnected && (
          <div className="space-y-3">
            <p className="text-[13px] font-medium text-[var(--text-secondary)] px-1">
              Or enter manually
            </p>

            <div className="space-y-2.5">
              <div className="flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border-default)] focus-within:border-[var(--border-heavy)] transition-colors">
                <Link2 className="w-4 h-4 text-[var(--text-tertiary)] shrink-0" />
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://xxx.trycloudflare.com"
                  className="flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--text-tertiary)]"
                />
              </div>

              <div className="flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border-default)] focus-within:border-[var(--border-heavy)] transition-colors">
                <KeyRound className="w-4 h-4 text-[var(--text-tertiary)] shrink-0" />
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="openyak_rt_..."
                  className="flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--text-tertiary)]"
                />
              </div>

              <button
                onClick={() => handleConnect(url.trim(), token.trim())}
                disabled={!url.trim() || !token.trim() || testing}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-[var(--text-primary)] text-[var(--surface-primary)] text-[14px] font-medium disabled:opacity-30 active:scale-[0.98] transition-all"
              >
                {testing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : testResult === "success" ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : testResult === "error" ? (
                  <XCircle className="w-4 h-4" />
                ) : null}
                {testing ? "Connecting..." : testResult === "success" ? "Connected!" : testResult === "error" ? "Failed" : "Connect"}
              </button>
            </div>
          </div>
        )}

        {/* Provider selector — only show when connected */}
        {isConnected && availableProviders.length > 0 && (
          <div className="space-y-3">
            <p className="text-[13px] font-medium text-[var(--text-secondary)] px-1">
              Model Access
            </p>
            <div className="space-y-2">
              {availableProviders.map((p) => {
                const isActive = activeProvider === p.id;
                const Icon = p.icon;
                return (
                  <button
                    key={p.id}
                    onClick={() => handleProviderSelect(p.id)}
                    className={`w-full flex items-center gap-3 p-4 rounded-2xl border transition-all active:scale-[0.98] ${
                      isActive
                        ? "border-[var(--text-primary)] bg-[var(--surface-secondary)]"
                        : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
                    }`}
                  >
                    <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                      isActive ? "bg-[var(--text-primary)] text-[var(--surface-primary)]" : "bg-[var(--surface-tertiary)] text-[var(--text-secondary)]"
                    }`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 text-left min-w-0">
                      <p className="text-[15px] font-medium">{p.label}</p>
                      <p className="text-[12px] text-[var(--text-tertiary)]">
                        {p.count} model{p.count !== 1 ? "s" : ""} available
                      </p>
                    </div>
                    {isActive && (
                      <div className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Channels */}
        <ChannelsStatusCard />

        {/* Instructions */}
        <div className="rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border-default)] p-4 space-y-2.5">
          <p className="text-[13px] font-medium">How to connect</p>
          <ol className="text-[12px] text-[var(--text-secondary)] space-y-1.5 list-decimal list-inside">
            <li>Open OpenYak on your desktop</li>
            <li>Go to Settings &rarr; Remote Access</li>
            <li>Enable and scan the QR code</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

/** Compact channels status card for mobile settings. */
function ChannelsStatusCard() {
  const { data: channelStatus } = useChannelStatus();
  const { data: channels } = useChannels();

  const running = channelStatus?.running ?? false;
  const channelEntries = Object.entries(channels?.channels ?? {});

  if (!running && channelEntries.length === 0) return null;

  return (
    <div className="rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border-default)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium">Channels</p>
        <div className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${running ? "bg-emerald-500" : "bg-[var(--text-tertiary)]"}`} />
          <span className="text-[11px] text-[var(--text-tertiary)]">
            {running ? "Running" : "Stopped"}
          </span>
        </div>
      </div>
      {channelEntries.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {channelEntries.map(([id, ch]) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 text-[11px] rounded-full border border-[var(--border-default)] px-2.5 py-1"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${
                ch.status === "connected" ? "bg-emerald-500" : "bg-[var(--text-tertiary)]"
              }`} />
              {ch.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
