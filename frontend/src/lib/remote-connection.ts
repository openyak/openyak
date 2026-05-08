/**
 * Remote connection state manager.
 *
 * Stores {url, token} in localStorage for persistent remote connections.
 * Used by mobile PWA to connect to a desktop OpenYak instance over the internet.
 */

const STORAGE_KEY = "openyak_remote_connection";

export interface RemoteConfig {
  url: string; // Tunnel URL (e.g., https://xxx.trycloudflare.com)
  token: string; // Bearer token (openyak_rt_...)
}

/** Get the stored remote connection config, or null if not connected. */
export function getRemoteConfig(): RemoteConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const config = JSON.parse(raw) as RemoteConfig;
    if (config.url && config.token) return config;
    return null;
  } catch {
    return null;
  }
}

/** Save remote connection config. */
export function saveRemoteConfig(config: RemoteConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** Clear remote connection (disconnect). */
export function clearRemoteConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Check if we're in remote mode (mobile PWA connected to a desktop instance). */
export function isRemoteMode(): boolean {
  return getRemoteConfig() !== null;
}

/** Get the remote token for injection into API/SSE requests. */
export function getRemoteToken(): string | null {
  return getRemoteConfig()?.token ?? null;
}

/** Get the remote backend URL. */
export function getRemoteUrl(): string | null {
  return getRemoteConfig()?.url ?? null;
}

// --- Provider preference (persisted separately from connection config) ---

export type RemoteProvider = "openrouter";

const PROVIDER_KEY = "openyak_remote_provider";

/** Get saved provider preference, or null for auto-detect. */
export function getRemoteProvider(): RemoteProvider | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(PROVIDER_KEY) as RemoteProvider | null;
}

/** Save provider preference. */
export function saveRemoteProvider(provider: RemoteProvider): void {
  localStorage.setItem(PROVIDER_KEY, provider);
}

/**
 * Parse QR code data into a RemoteConfig.
 *
 * Supports two formats:
 * - URL format (from backend QR): "https://xxx.trycloudflare.com/m?token=openyak_rt_..."
 * - JSON format (legacy): {"url":"https://...","token":"openyak_rt_..."}
 */
/**
 * Auto-connect from URL query params (e.g., ?token=openyak_rt_...).
 * Called on mobile page load to enable direct link sharing.
 * Returns true if a new connection was established.
 */
export function autoConnectFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) return false;

    // Derive the tunnel URL from the current page origin
    const url = window.location.origin;

    // Only save if not already connected to this exact config
    const existing = getRemoteConfig();
    if (existing?.url === url && existing?.token === token) return false;

    saveRemoteConfig({ url, token });

    // Clean up URL to remove token from address bar
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("token");
    window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search);

    return true;
  } catch {
    return false;
  }
}

export function parseQRData(data: string): RemoteConfig | null {
  // Try URL format first (backend encodes: {tunnel_url}/m?token={token})
  try {
    const url = new URL(data);
    const token = url.searchParams.get("token");
    if (token) {
      return { url: url.origin, token };
    }
  } catch {
    // Not a valid URL — try JSON below
  }

  // Try JSON format
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed.url === "string" && typeof parsed.token === "string") {
      return { url: parsed.url, token: parsed.token };
    }
  } catch {
    // Not valid JSON either
  }

  return null;
}
