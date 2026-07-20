"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Wifi, WifiOff, QrCode, Copy, RefreshCw, Shield, Check, Loader2, AlertTriangle, Eye, EyeOff, ExternalLink, Unplug } from "lucide-react";
import Image from "next/image";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, apiFetch } from "@/lib/api";
import { API, getBackendUrl } from "@/lib/constants";
import {
  useChannels,
  useAddChannel,
  useRemoveChannel,
} from "@/hooks/use-channels";
import {
  WhatsAppIcon, DiscordIcon, TelegramIcon, SlackIcon, FeishuIcon,
  WeChatIcon, DingTalkIcon, EmailIcon, QQIcon, MatrixIcon,
  WeComIcon, WebSocketIcon, MoChatIcon,
} from "@/components/icons/platform-icons";
import type { PlatformDef } from "@/types/channels";

/* ------------------------------------------------------------------ */
/* Tab content (embedded in Settings)                                  */
/* ------------------------------------------------------------------ */

export function RemoteTabContent() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<{
    enabled: boolean;
    tunnel_url: string | null;
    token_preview: string | null;
    active_tasks: number;
    tunnel_mode: string;
    permission_mode: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrBlobUrl, setQrBlobUrl] = useState<string | null>(null);
  const [fullToken, setFullToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [permMode, setPermMode] = useState("auto");
  const [tunnelChanged, setTunnelChanged] = useState(false);
  const prevTunnelUrl = useRef<string | null>(null);

  // Fetch QR image as blob URL to bypass Tauri CSP (img-src blocks http://127.0.0.1)
  const fetchQrBlob = useCallback(async () => {
    try {
      const res = await apiFetch(`${API.REMOTE.QR}?t=${Date.now()}`);
      if (!res.ok) return;
      const blob = await res.blob();
      // Revoke previous blob URL to avoid memory leaks
      setQrBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
    } catch {}
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.get<typeof status>(API.REMOTE.STATUS);
      setStatus(data);
      if (data) {
        setPermMode(data.permission_mode);

        // Detect tunnel URL change — show warning to re-scan QR
        if (prevTunnelUrl.current !== null && data.tunnel_url && data.tunnel_url !== prevTunnelUrl.current) {
          setTunnelChanged(true);
          // Auto-refresh QR code when URL changes
          if (showQr) { fetchQrBlob(); }
        }
        prevTunnelUrl.current = data.tunnel_url ?? null;
      }
    } catch {
      // Remote API not available
    } finally {
      setLoading(false);
    }
  }, [fetchQrBlob, showQr]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Poll status every 30s to detect tunnel restarts
  useEffect(() => {
    if (!status?.enabled) return;
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus, status?.enabled]);

  const handleToggle = async () => {
    if (!status) return;
    setToggling(true);
    setTunnelChanged(false);
    try {
      if (status.enabled) {
        await api.post(API.REMOTE.DISABLE);
        setShowQr(false); setQrBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; }); setFullToken(null);
        prevTunnelUrl.current = null;
      } else {
        const result = await api.post<{ token: string; tunnel_url: string | null }>(API.REMOTE.ENABLE);
        setFullToken(result.token);
        await fetchStatus();
        await fetchQrBlob();
        setShowQr(true);
        return;
      }
      await fetchStatus();
    } catch (err) {
      console.error("Failed to toggle remote access:", err);
    } finally {
      setToggling(false);
    }
  };

  const handleShowQr = async () => {
    if (showQr) { setShowQr(false); return; }
    await fetchQrBlob();
    setShowQr(true);
    setTunnelChanged(false);
  };

  const handleRotateToken = async () => {
    try {
      const result = await api.post<{ token: string }>(API.REMOTE.ROTATE_TOKEN);
      setFullToken(result.token);
      await fetchStatus();
      if (showQr) handleShowQr();
    } catch {}
  };

  const handleCopyUrl = () => {
    if (status?.tunnel_url) {
      const token = fullToken || status.token_preview;
      const url = token
        ? `${status.tunnel_url}/m?token=${encodeURIComponent(token)}`
        : `${status.tunnel_url}/m`;
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePermModeChange = async (mode: string) => {
    setPermMode(mode);
    try { await api.patch(API.REMOTE.CONFIG, { permission_mode: mode }); } catch {}
  };

  if (loading) {
    return <div className="h-16 rounded-lg bg-[var(--surface-tertiary)] animate-pulse" />;
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-secondary)]">{t("remoteDesc")}</p>

      {/* Tunnel URL changed warning */}
      {tunnelChanged && status?.enabled && (
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-3 animate-slide-up">
          <AlertTriangle className="h-4 w-4 text-[var(--color-warning)] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t("tunnelUrlChanged")}</p>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {t("tunnelUrlChangedDesc")}
            </p>
          </div>
          <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={handleShowQr}>
            <QrCode className="h-3 w-3 mr-1" />
            {t("tunnelShowQr")}
          </Button>
        </div>
      )}

      {/* Enable/Disable toggle */}
      <div className="flex items-center justify-between rounded-lg border border-[var(--border-default)] p-3">
        <div className="flex items-center gap-3">
          {toggling ? <Loader2 className="h-4 w-4 animate-spin text-[var(--text-secondary)]" /> : status?.enabled ? <Wifi className="h-4 w-4 text-[var(--color-success)]" /> : <WifiOff className="h-4 w-4 text-[var(--text-tertiary)]" />}
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">{toggling ? t("remoteStarting") : status?.enabled ? t("remoteActive") : t("remoteDisabled")}</p>
            {status?.enabled && status.tunnel_url && <p className="text-xs text-[var(--text-secondary)] truncate max-w-[280px]">{status.tunnel_url}</p>}
          </div>
        </div>
        <Switch checked={status?.enabled ?? false} onCheckedChange={handleToggle} disabled={toggling} />
      </div>

      {/* When enabled: show controls */}
      {status?.enabled && (
        <div className="space-y-3">
          {status.tunnel_url && (
            <div className="flex items-center gap-2">
              <div className="flex-1 px-3 py-2 rounded-lg bg-[var(--surface-tertiary)] text-xs font-mono text-[var(--text-secondary)] truncate">
                {status.tunnel_url}/m{fullToken ? `?token=${fullToken.slice(0, 12)}...` : ""}
              </div>
              <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={handleCopyUrl}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span className="ml-1 text-xs">{copied ? t("remoteCopied") : t("remoteCopy")}</span>
              </Button>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={handleShowQr}>
              <QrCode className="h-3 w-3" /><span className="ml-1 text-xs">{showQr ? t("remoteHideQr") : t("remoteShowQr")}</span>
            </Button>
            <Button variant="outline" size="sm" className="h-8" onClick={handleRotateToken}>
              <RefreshCw className="h-3 w-3" /><span className="ml-1 text-xs">{t("remoteRotateToken")}</span>
            </Button>
          </div>

          {showQr && qrBlobUrl && (
            <div className="flex justify-center p-4 rounded-lg bg-white">
              <Image
                src={qrBlobUrl}
                alt={t("remoteQrAlt")}
                width={192}
                height={192}
                unoptimized
                className="w-48 h-48"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
          )}

          {!fullToken && status.token_preview && <p className="text-xs text-[var(--text-tertiary)]">{t("remoteTokenPreview", { preview: status.token_preview })}</p>}

          <div className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] p-3">
            <Shield className="h-4 w-4 text-[var(--text-secondary)] shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-[var(--text-primary)]">{t("remotePermission")}</p>
              <p className="text-xs text-[var(--text-secondary)]">{t("remotePermissionDesc")}</p>
            </div>
            <select value={permMode} onChange={(e) => handlePermModeChange(e.target.value)} className="px-2 py-1 rounded-md bg-[var(--surface-tertiary)] text-xs border border-[var(--border-default)] text-[var(--text-primary)]">
              <option value="auto">{t("remotePermAuto")}</option>
              <option value="ask">{t("remotePermAsk")}</option>
              <option value="deny">{t("remotePermDeny")}</option>
            </select>
          </div>

          {status.active_tasks > 0 && <p className="text-xs text-[var(--text-secondary)]">{t("remoteActiveTasks", { n: status.active_tasks })}</p>}
        </div>
      )}

      {!status?.enabled && (
        <div className="p-3 rounded-lg bg-[var(--surface-tertiary)] text-xs text-[var(--text-secondary)] space-y-1.5">
          <p>{t("remoteInstructions")}</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>{t("remoteStep1")}</li>
            <li>{t("remoteStep2")}</li>
            <li>{t("remoteStep3")}</li>
          </ol>
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-[var(--border-default)]" />

      {/* Messaging Channels */}
      <ChannelsSection />
    </div>
  );
}



/* ------------------------------------------------------------------ */
/* Messaging Channels Section (nanobot-based, in-process)              */
/* ------------------------------------------------------------------ */

const PLATFORMS: PlatformDef[] = [
  // --- Major platforms ---
  { id: "whatsapp", name: "WhatsApp", icon: <WhatsAppIcon size={18} />, color: "text-[#25D366]", auth: "qr",
    help: "Scan QR code with your phone to link WhatsApp" },
  { id: "telegram", name: "Telegram", icon: <TelegramIcon size={18} />, color: "text-[#26A5E4]", auth: "token",
    help: "Get a token from @BotFather on Telegram",
    helpUrl: "https://t.me/BotFather",
    fields: [{ key: "token", label: "Bot Token", placeholder: "123456:ABC-DEF...", secret: true }] },
  { id: "discord", name: "Discord", icon: <DiscordIcon size={18} />, color: "text-[#5865F2]", auth: "token",
    help: "Create a bot at Discord Developer Portal",
    helpUrl: "https://discord.com/developers/applications",
    fields: [{ key: "token", label: "Bot Token", placeholder: "Paste Discord bot token", secret: true }] },
  { id: "slack", name: "Slack", icon: <SlackIcon size={18} />, color: "text-[#E01E5A]", auth: "token",
    help: "Create an app at api.slack.com/apps",
    helpUrl: "https://api.slack.com/apps",
    fields: [
      { key: "bot_token", label: "Bot Token", placeholder: "xoxb-...", secret: true },
      { key: "app_token", label: "App Token", placeholder: "xapp-...", secret: true },
    ] },
  // --- China platforms ---
  { id: "weixin", name: "WeChat", icon: <WeChatIcon size={18} />, color: "text-[#07C160]", auth: "token",
    help: "Requires WeChat HTTP API (e.g. ilinkai)",
    fields: [
      { key: "api_url", label: "API URL", placeholder: "http://localhost:9503", secret: false },
    ] },
  { id: "feishu", name: "Feishu", icon: <FeishuIcon size={18} />, color: "text-[#3370FF]", auth: "token",
    help: "Create an app at Feishu Open Platform",
    helpUrl: "https://open.feishu.cn/app",
    fields: [
      { key: "app_id", label: "App ID", placeholder: "cli_xxxxx", secret: false },
      { key: "app_secret", label: "App Secret", placeholder: "Enter app secret", secret: true },
    ] },
  { id: "dingtalk", name: "DingTalk", icon: <DingTalkIcon size={18} />, color: "text-[#0089FF]", auth: "token",
    help: "Create a bot at DingTalk Open Platform",
    helpUrl: "https://open.dingtalk.com",
    fields: [
      { key: "token", label: "App Key", placeholder: "Enter DingTalk app key", secret: true },
    ] },
  { id: "wecom", name: "WeCom", icon: <WeComIcon size={18} />, color: "text-[#0082EF]", auth: "token",
    help: "Create a bot at WeCom Admin Console",
    fields: [
      { key: "token", label: "Corp ID / Secret", placeholder: "Enter WeCom credentials", secret: true },
    ] },
  { id: "qq", name: "QQ", icon: <QQIcon size={18} />, color: "text-[#12B7F5]", auth: "token",
    help: "Create a bot at QQ Open Platform",
    helpUrl: "https://q.qq.com",
    fields: [
      { key: "token", label: "App ID / Secret", placeholder: "Enter QQ bot credentials", secret: true },
    ] },
  // --- Other platforms ---
  { id: "email", name: "Email", icon: <EmailIcon size={18} />, color: "text-[#EA4335]", auth: "token",
    help: "Connect via IMAP/SMTP",
    fields: [
      { key: "token", label: "IMAP/SMTP Config", placeholder: "See docs for config format", secret: false },
    ] },
  { id: "matrix", name: "Matrix", icon: <MatrixIcon size={18} />, color: "text-[#0DBD8B]", auth: "token",
    help: "Connect to a Matrix homeserver",
    fields: [
      { key: "token", label: "Access Token", placeholder: "Enter Matrix access token", secret: true },
    ] },
  { id: "mochat", name: "MoChat", icon: <MoChatIcon size={18} />, color: "text-[#6366F1]", auth: "token",
    help: "Connect to MoChat server",
    fields: [
      { key: "token", label: "API Token", placeholder: "Enter MoChat API token", secret: true },
    ] },
  { id: "websocket", name: "WebSocket", icon: <WebSocketIcon size={18} />, color: "text-[#64748B]", auth: "token",
    help: "Generic WebSocket channel for custom integrations",
    fields: [
      { key: "token", label: "WebSocket URL", placeholder: "ws://localhost:8765", secret: false },
    ] },
];

function ChannelsSection() {
  const { t } = useTranslation("settings");
  const { data: channelsData, refetch: refetchChannels } = useChannels();
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);

  const channels = channelsData?.channels ?? {};

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("channelsTitle")}</h2>
      <p className="text-xs text-[var(--text-secondary)]">
        {t("channelsDesc")}
      </p>

      {/* Status indicator */}
      <div className="rounded-lg border border-[var(--border-default)] p-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" />
          <span className="text-xs font-medium text-[var(--text-primary)]">Channel System</span>
          <span className="text-ui-3xs text-[var(--text-tertiary)]">
            Built-in &middot; {Object.keys(channels).length} active
          </span>
        </div>
      </div>

      {/* Platform cards grid */}
      <div className="grid grid-cols-2 gap-2">
        {PLATFORMS.map((p) => {
          const connected = !!channels[p.id];
          const isExpanded = expandedPlatform === p.id;
          return (
            <div key={p.id} className={`rounded-lg border p-3 space-y-2 transition-colors ${
              connected ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/5" : "border-[var(--border-default)]"
            } ${isExpanded ? "col-span-2" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={p.color}>{p.icon}</span>
                  <span className="text-xs font-medium text-[var(--text-primary)]">{p.name}</span>
                  {connected && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />}
                </div>
                {!connected ? (
                  <Button variant="outline" size="sm" className="h-6 text-ui-3xs px-2"
                    onClick={() => setExpandedPlatform(isExpanded ? null : p.id)}>
                    {isExpanded ? t("channelCancel") : t("channelConnect")}
                  </Button>
                ) : (
                  <RemoveChannelButton channel={p.id} onRemoved={() => refetchChannels()} />
                )}
              </div>

              {/* Expanded: setup form */}
              {isExpanded && (
                <div className="pt-1">
                  {p.auth === "qr" ? (
                    <QrLoginFlow channel={p.id} onDone={() => {
                      setExpandedPlatform(null);
                      setTimeout(() => refetchChannels(), 2000);
                    }} />
                  ) : (
                    <TokenForm platform={p} onDone={() => { setExpandedPlatform(null); refetchChannels(); }} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Token-based channel setup form (Discord, Telegram, Slack, Feishu). */
function TokenForm({ platform, onDone }: { platform: PlatformDef; onDone: () => void }) {
  const { t } = useTranslation("settings");
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const addChannel = useAddChannel();

  const handleSubmit = async () => {
    setError(null);
    const body: Record<string, string> = { channel: platform.id };
    for (const f of platform.fields || []) {
      if (!values[f.key]?.trim()) {
        setError(t("channelFieldRequired", { field: t(`fieldLabel_${f.key}`, f.label) }));
        return;
      }
      body[f.key] = values[f.key].trim();
    }

    addChannel.mutate(body, {
      onSuccess: (result) => {
        if (result.ok) { onDone(); }
        else { setError(result.message); }
      },
      onError: (e) => setError(String(e)),
    });
  };

  return (
    <div className="space-y-2">
      {platform.fields?.map((f) => (
        <div key={f.key} className="relative">
          <label className="text-ui-3xs text-[var(--text-tertiary)] mb-0.5 block">{t(`fieldLabel_${platform.id}_${f.key}`, t(`fieldLabel_${f.key}`, f.label))}</label>
          <div className="relative">
            <input
              type={f.secret && !showSecret[f.key] ? "password" : "text"}
              value={values[f.key] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={t(`fieldPlaceholder_${platform.id}_${f.key}`, f.placeholder)}
              autoComplete="one-time-code"
              className="w-full h-7 rounded-md border border-[var(--border-default)] bg-transparent px-2.5 pr-7 text-xs font-mono text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
            />
            {f.secret && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
                onClick={() => setShowSecret((s) => ({ ...s, [f.key]: !s[f.key] }))}>
                {showSecret[f.key] ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            )}
          </div>
        </div>
      ))}

      {platform.helpUrl && (
        <a href={platform.helpUrl} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-ui-3xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
          <ExternalLink className="h-2.5 w-2.5" />{t(`platformHelp_${platform.id}`, platform.help)}
        </a>
      )}

      {error && (
        <p className="text-ui-2xs text-[var(--color-destructive)]">{error}</p>
      )}

      <Button size="sm" className="h-7 text-ui-2xs w-full" onClick={handleSubmit}
        disabled={addChannel.isPending}>
        {addChannel.isPending ? <><Loader2 className="h-3 w-3 animate-spin" />{t("channelConnecting")}</> : t("channelConnect")}
      </Button>
    </div>
  );
}

/** WhatsApp QR login flow (SSE streaming). */
function QrLoginFlow({ channel, onDone }: { channel: string; onDone: () => void }) {
  const { t } = useTranslation("settings");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrText, setQrText] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("qrPreparing");
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        await getBackendUrl();
        const resp = await apiFetch(API.CHANNELS.LOGIN, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel }),
          timeoutMs: 120_000,
        });

        if (!resp.ok || !resp.body) {
          setError(t("qrFailedLogin"));
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.status === "qr") {
                setQrUrl(data.qr_data_url);
                setQrText(null);
                setStatus("qrScanPhone");
              } else if (data.status === "qr_text") {
                setQrText(data.qr_text);
                setQrUrl(null);
                setStatus("qrScanWhatsapp");
              } else if (data.status === "connected" || data.status === "done") {
                setStatus(data.status === "connected" ? "qrConnected" : "qrDone");
                setTimeout(onDone, 1000);
                return;
              } else if (data.status === "error") {
                setError(data.message);
                return;
              } else if (data.status === "waiting") {
                setStatus(data.message || "qrWaiting");
              } else if (data.message) {
                setStatus(data.message);
              }
            } catch { /* ignore */ }
          }
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [channel, onDone, t]);

  if (error) {
    return <p className="text-ui-2xs text-[var(--color-destructive)] py-2">{error}</p>;
  }

  return (
    <div className="space-y-2 py-1">
      {qrUrl ? (
        <div className="flex justify-center p-3 rounded-lg bg-white">
          <Image
            src={qrUrl}
            alt={t("qrCodeAlt")}
            width={192}
            height={192}
            unoptimized
            className="w-48 h-48"
            style={{ imageRendering: "pixelated" }}
          />
        </div>
      ) : qrText ? (
        <div className="flex justify-center p-2 rounded-lg bg-white overflow-x-auto">
          <pre className="text-black text-ui-qr font-mono whitespace-pre select-none">{qrText}</pre>
        </div>
      ) : (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
        </div>
      )}
      <p className="text-center text-ui-2xs text-[var(--text-secondary)]">{t(status, status)}</p>
    </div>
  );
}

/** Remove/disconnect channel button. */
function RemoveChannelButton({ channel, onRemoved }: { channel: string; onRemoved: () => void }) {
  const { t } = useTranslation("settings");
  const removeChannel = useRemoveChannel();
  const [removed, setRemoved] = useState(false);

  if (removed) {
    return <span className="text-ui-3xs text-[var(--text-tertiary)]">{t("channelRemoved")}</span>;
  }

  const handleRemove = async () => {
    try {
      await removeChannel.mutateAsync({ channel });
    } catch { /* ignore */ }
    setRemoved(true);
    // Delay slightly to let backend update
    setTimeout(onRemoved, 500);
  };

  return (
    <Button variant="outline" size="sm" className="h-6 text-ui-3xs px-2 text-[var(--color-destructive)] border-[var(--color-destructive)]/30 hover:bg-[var(--color-destructive)]/10"
      disabled={removeChannel.isPending}
      onClick={handleRemove}>
      {removeChannel.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Unplug className="h-3 w-3" />{t("channelDisconnect")}</>}
    </Button>
  );
}
