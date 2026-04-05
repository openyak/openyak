/** API route constants — these go through Next.js rewrites to the FastAPI backend. */

import { desktopAPI } from "./tauri-api";
import { getRemoteConfig } from "./remote-connection";

/** Whether we are running inside a desktop shell (Tauri). */
export const IS_DESKTOP =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Title bar height in pixels (for desktop mode). */
export const TITLE_BAR_HEIGHT = 32;

/**
 * Backend URL — resolved dynamically in desktop mode via IPC.
 *
 * In web mode: uses Next.js proxy (relative URLs) + direct backend for SSE.
 * In desktop mode: all calls go directly to the backend URL.
 */
let _backendUrl: string | null = null;
let _backendUrlPromise: Promise<string> | null = null;

/** Direct backend URL for SSE streams (avoids Next.js proxy buffering). */
const FALLBACK_BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/**
 * Get the backend URL. In desktop mode, this is resolved asynchronously
 * from the desktop shell on first call, then cached.
 */
export function getBackendUrl(): Promise<string> {
  if (_backendUrl) return Promise.resolve(_backendUrl);
  if (_backendUrlPromise) return _backendUrlPromise;

  if (IS_DESKTOP) {
    _backendUrlPromise = desktopAPI.getBackendUrl().then((url) => {
      _backendUrl = url;
      return url;
    });
    return _backendUrlPromise;
  }

  _backendUrl = FALLBACK_BACKEND_URL;
  return Promise.resolve(_backendUrl);
}

/**
 * Clear the cached backend URL. Called when the desktop backend restarts
 * on a new port so the next `getBackendUrl()` re-fetches via IPC.
 */
export function resetBackendUrl(newUrl?: string): void {
  if (newUrl) {
    _backendUrl = newUrl;
  } else {
    _backendUrl = null;
  }
  _backendUrlPromise = null;
}

// Auto-register desktop backend event listeners
if (IS_DESKTOP && typeof window !== "undefined") {
  desktopAPI.onBackendRestart((newUrl) => {
    // Backend restart detected — update URL for all future API calls.
    resetBackendUrl(newUrl);
  });
  desktopAPI.onBackendCrashLog((log) => {
    console.error(
      "%c[Backend Crash Log]%c\n%s",
      "color: red; font-weight: bold",
      "color: inherit",
      log,
    );
  });
}

/**
 * Get the backend URL synchronously. Returns the cached value or fallback.
 * Use this only when you can't await (e.g., in constant definitions).
 */
export function getBackendUrlSync(): string {
  if (IS_DESKTOP) {
    if (!_backendUrl) {
      throw new Error("Desktop backend URL is not ready yet");
    }
    return _backendUrl;
  }
  return _backendUrl || FALLBACK_BACKEND_URL;
}

/**
 * Resolve an API path.
 * - Desktop mode: prepends backend URL to make absolute.
 * - Web mode: returns relative path (Next.js proxy handles it).
 */
export function resolveApiUrl(path: string): string {
  if (IS_DESKTOP) {
    if (!_backendUrl) {
      throw new Error("Desktop backend URL is not ready yet");
    }
    return `${_backendUrl}${path}`;
  }
  return path;
}

export const API = {
  CHAT: {
    PROMPT: "/api/chat/prompt",
    EDIT: "/api/chat/edit",
    STREAM: (streamId: string) => {
      // Remote mode: use tunnel URL instead of localhost
      const rc = getRemoteConfig();
      if (rc) return `${rc.url}/api/chat/stream/${streamId}`;
      return `${getBackendUrlSync()}/api/chat/stream/${streamId}`;
    },
    ABORT: "/api/chat/abort",
    ACTIVE: "/api/chat/active",
    RESPOND: "/api/chat/respond",
  },
  SESSIONS: {
    BASE: "/api/sessions",
    LIST: (limit = 50, offset = 0) => `/api/sessions?limit=${limit}&offset=${offset}`,
    SEARCH: (q: string, limit = 20, offset = 0) =>
      `/api/sessions/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    DETAIL: (id: string) => `/api/sessions/${id}`,
    EXPORT_PDF: (id: string) => `/api/sessions/${id}/export-pdf`,
    EXPORT_MD: (id: string) => `/api/sessions/${id}/export-md`,
    TODOS: (id: string) => `/api/sessions/${id}/todos`,
    FILES: (id: string) => `/api/sessions/${id}/files`,
  },
  MESSAGES: {
    LIST: (sessionId: string, limit = 50, offset = -1) =>
      `/api/messages/${sessionId}?limit=${limit}&offset=${offset}`,
  },
  FILES: {
    UPLOAD: "/api/files/upload",
    BROWSE: "/api/files/browse",
    BROWSE_DIRECTORY: "/api/files/browse-directory",
    LIST_DIRECTORY: "/api/files/list-directory",
    ATTACH: "/api/files/attach",
    CONTENT: "/api/files/content",
    CONTENT_BINARY: "/api/files/content-binary",
    OPEN_SYSTEM: "/api/files/open-system",
    SEARCH: "/api/files/search",
    INGEST: "/api/files/ingest",
  },
  ARTIFACTS: {
    EXPORT_PDF: "/api/artifacts/export-pdf",
  },
  USAGE: "/api/usage",
  CONFIG: {
    API_KEY: "/api/config/api-key",
    PROVIDERS: "/api/config/providers",
    PROVIDER_KEY: (id: string) => `/api/config/providers/${id}/key` as const,
    PROVIDER_TOGGLE: (id: string) => `/api/config/providers/${id}/toggle` as const,
    CUSTOM_ENDPOINT: "/api/config/custom",
    CUSTOM_ENDPOINT_ITEM: (id: string) => `/api/config/custom/${id}` as const,
    OPENYAK_ACCOUNT: "/api/config/openyak-account",
    OPENAI_SUBSCRIPTION: "/api/config/openai-subscription",
    OPENAI_SUBSCRIPTION_LOGIN: "/api/config/openai-subscription/login",
    OPENAI_SUBSCRIPTION_MANUAL_CALLBACK: "/api/config/openai-subscription/manual-callback",
    OLLAMA: "/api/config/ollama",
    LOCAL_PROVIDER: "/api/config/local",
  },
  FTS: {
    INDEX: (workspace: string, sessionId?: string) =>
      `/api/fts/index/${workspace.replace(/\\/g, "/")}${sessionId ? `?session_id=${sessionId}` : ""}`,
  },
  OLLAMA: {
    STATUS: "/api/ollama/status",
    SETUP: "/api/ollama/setup",
    START: "/api/ollama/start",
    STOP: "/api/ollama/stop",
    MODELS: "/api/ollama/models",
    LIBRARY: "/api/ollama/models/library",
    UNINSTALL: (deleteModels: boolean) =>
      `/api/ollama/uninstall?delete_models=${deleteModels}` as const,
    PULL: "/api/ollama/models/pull",
    DELETE: (name: string) => `/api/ollama/models/${encodeURIComponent(name)}` as const,
    INFO: (name: string) => `/api/ollama/models/${encodeURIComponent(name)}/info` as const,
    WARMUP: "/api/ollama/warmup",
  },
  AGENTS: "/api/agents",
  MODELS: "/api/models",
  TOOLS: "/api/tools",
  SKILLS: {
    LIST: "/api/skills",
    ENABLE: (name: string) => `/api/skills/${name}/enable` as const,
    DISABLE: (name: string) => `/api/skills/${name}/disable` as const,
  },
  MCP: {
    STATUS: "/api/mcp/status",
    RECONNECT: (name: string) => `/api/mcp/${name}/reconnect` as const,
    AUTH_START: (name: string) => `/api/mcp/${name}/auth-start` as const,
    AUTH_CALLBACK: (name: string) => `/api/mcp/${name}/auth-callback` as const,
    DISCONNECT: (name: string) => `/api/mcp/${name}/disconnect` as const,
  },
  GOOGLE: {
    AUTH_START: "/api/google/auth-start",
    STATUS: "/api/google/status",
  },
  CONNECTORS: {
    LIST: "/api/connectors",
    DETAIL: (id: string) => `/api/connectors/${id}` as const,
    ADD: "/api/connectors",
    REMOVE: (id: string) => `/api/connectors/${id}` as const,
    ENABLE: (id: string) => `/api/connectors/${id}/enable` as const,
    DISABLE: (id: string) => `/api/connectors/${id}/disable` as const,
    CONNECT: (id: string) => `/api/connectors/${id}/connect` as const,
    DISCONNECT: (id: string) => `/api/connectors/${id}/disconnect` as const,
    SET_TOKEN: (id: string) => `/api/connectors/${id}/token` as const,
    RECONNECT: (id: string) => `/api/connectors/${id}/reconnect` as const,
  },
  PLUGINS: {
    STATUS: "/api/plugins/status",
    DETAIL: (name: string) => `/api/plugins/${name}` as const,
    ENABLE: (name: string) => `/api/plugins/${name}/enable` as const,
    DISABLE: (name: string) => `/api/plugins/${name}/disable` as const,
  },
  AUTOMATIONS: {
    LIST: "/api/automations",
    CREATE: "/api/automations",
    DETAIL: (id: string) => `/api/automations/${id}` as const,
    UPDATE: (id: string) => `/api/automations/${id}` as const,
    DELETE: (id: string) => `/api/automations/${id}` as const,
    RUN: (id: string) => `/api/automations/${id}/run` as const,
    RUNS: (id: string) => `/api/automations/${id}/runs` as const,
    TEMPLATES: "/api/automations/templates",
    FROM_TEMPLATE: "/api/automations/from-template",
    LOOP_PRESETS: "/api/automations/loop-presets",
  },
  CHANNELS: {
    LIST: "/api/channels",
    ADD: "/api/channels/add",
    LOGIN: "/api/channels/login",
    REMOVE: "/api/channels/remove",
    OPENCLAW_STATUS: "/api/channels/openclaw/status",
    OPENCLAW_SETUP: "/api/channels/openclaw/setup",
    OPENCLAW_START: "/api/channels/openclaw/start",
    OPENCLAW_STOP: "/api/channels/openclaw/stop",
    OPENCLAW_UNINSTALL: "/api/channels/openclaw/uninstall",
  },
  WORKSPACE_MEMORY: {
    BASE: "/api/workspace-memory",
    LIST: "/api/workspace-memory/list",
    REFRESH: "/api/workspace-memory/refresh",
    EXPORT: "/api/workspace-memory/export",
  },
  HEALTH: "/health",
  REMOTE: {
    ENABLE: "/api/remote/enable",
    DISABLE: "/api/remote/disable",
    STATUS: "/api/remote/status",
    QR: "/api/remote/qr",
    ROTATE_TOKEN: "/api/remote/rotate-token",
    CONFIG: "/api/remote/config",
    TASKS: "/api/remote/tasks",
    PROVIDER_INFO: "/api/remote/provider-info",
  },
} as const;

/** Query key factories for TanStack Query. */
export const queryKeys = {
  sessions: {
    all: ["sessions"] as const,
    detail: (id: string) => ["sessions", id] as const,
    search: (q: string) => ["sessions", "search", q] as const,
    todos: (id: string) => ["sessions", id, "todos"] as const,
  },
  messages: {
    list: (sessionId: string) => ["messages", sessionId] as const,
  },
  models: ["models"] as const,
  agents: ["agents"] as const,
  tools: ["tools"] as const,
  skills: ["skills"] as const,
  usage: (days: number) => ["usage", days] as const,
  apiKeyStatus: ["apiKeyStatus"] as const,
  providers: ["providers"] as const,
  openyakAccount: ["openyakAccount"] as const,
  openaiSubscription: ["openaiSubscription"] as const,
  localProvider: ["localProvider"] as const,
  ollamaStatus: ["ollamaStatus"] as const,
  connectors: ["connectors"] as const,
  channels: ["channels"] as const,
  openclawStatus: ["openclawStatus"] as const,
  plugins: {
    all: ["plugins"] as const,
    detail: (name: string) => ["plugins", name] as const,
  },
  automations: {
    all: ["automations"] as const,
    detail: (id: string) => ["automations", id] as const,
    runs: (id: string) => ["automations", id, "runs"] as const,
    templates: ["automations", "templates"] as const,
  },
  workspaceMemory: (workspace: string) =>
    ["workspaceMemory", workspace] as const,
  workspaceMemoryList: ["workspaceMemoryList"] as const,
  indexStatus: (workspace: string) => ["indexStatus", workspace] as const,
} as const;

/** UI constants */
export const SIDEBAR_WIDTH = 280;
export const ACTIVITY_PANEL_WIDTH = 380;
export const ARTIFACT_PANEL_WIDTH = 520;
export const WORKSPACE_PANEL_WIDTH = 320;
export const MOBILE_BREAKPOINT = 768;
export const MAX_INPUT_HEIGHT = 200;
export const SSE_HEARTBEAT_TIMEOUT = 45_000;
export const SSE_RECONNECT_DELAY = 1_000;
export const SSE_RECONNECT_MAX_DELAY = 15_000;
export const SSE_RECONNECT_BACKOFF = 2;
export const SSE_MAX_RETRIES = 8;
export const PERMISSION_TIMEOUT = 300_000; // 5 minutes — matches backend
