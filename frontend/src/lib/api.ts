/** Lightweight fetch wrapper for the OpenYak backend API. */

import {
  getBackendToken,
  getBackendUrl,
  IS_DESKTOP,
  resolveApiUrl,
} from "./constants";
import { getRemoteConfig } from "./remote-connection";
import i18n from "@/i18n/config";

class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
  ) {
    super(`API ${status}: ${statusText}`);
    this.name = "ApiError";
  }
}

/** Max retries for network errors (connection refused/reset during backend restart). */
const NETWORK_RETRY_MAX = 3;
const DEFAULT_GET_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 120_000;

export type ApiRequestInit = RequestInit & {
  timeoutMs?: number;
};

async function resolveRequestUrl(url: string): Promise<string> {
  const remoteConfig = getRemoteConfig();
  if (remoteConfig) {
    return url.startsWith("http") ? url : `${remoteConfig.url}${url}`;
  }
  if (IS_DESKTOP) {
    const backend = await getBackendUrl();
    return url.startsWith("http") ? url : `${backend}${url}`;
  }
  return resolveApiUrl(url);
}

async function buildAuthHeaders(): Promise<Record<string, string>> {
  const remoteConfig = getRemoteConfig();
  if (remoteConfig) {
    return { Authorization: `Bearer ${remoteConfig.token}` };
  }
  if (IS_DESKTOP) {
    const token = await getBackendToken();
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

export async function apiFetch(
  url: string,
  options?: ApiRequestInit,
): Promise<Response> {
  const { timeoutMs, ...fetchOptions } = options ?? {};
  const method = fetchOptions.method?.toUpperCase() ?? "GET";
  const requestTimeoutMs =
    timeoutMs ?? (method === "GET" ? DEFAULT_GET_TIMEOUT_MS : DEFAULT_MUTATION_TIMEOUT_MS);
  const resolvedUrl = await resolveRequestUrl(url);
  const authHeaders = await buildAuthHeaders();

  const headers = new Headers(fetchOptions.headers);
  headers.set("Accept-Language", headers.get("Accept-Language") || i18n.language || "en");
  for (const [key, value] of Object.entries(authHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
  }

  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, requestTimeoutMs);

  const callerSignal = fetchOptions.signal;
  const abortFromCaller = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    const res = await fetch(resolvedUrl, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (didTimeout) {
      throw new Error(`Request timed out while contacting ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function request<T>(
  url: string,
  options?: ApiRequestInit,
): Promise<T> {
  const { timeoutMs, ...fetchOptions } = options ?? {};
  const method = fetchOptions.method?.toUpperCase() ?? "GET";
  const requestTimeoutMs =
    timeoutMs ?? (method === "GET" ? DEFAULT_GET_TIMEOUT_MS : DEFAULT_MUTATION_TIMEOUT_MS);

  // Remote mode: use tunnel URL + inject Bearer token
  const remoteConfig = getRemoteConfig();

  let resolvedUrl: string;
  if (remoteConfig) {
    resolvedUrl = url.startsWith("http") ? url : `${remoteConfig.url}${url}`;
  } else if (IS_DESKTOP) {
    const backend = await getBackendUrl();
    resolvedUrl = url.startsWith("http") ? url : `${backend}${url}`;
  } else {
    resolvedUrl = resolveApiUrl(url);
  }

  let lastError: unknown;

  // Build auth headers. In remote mode we use the tunnel-issued token;
  // in desktop mode we use the per-run session token fetched through
  // Tauri IPC (the backend writes a 0600 file that only our user can
  // read, preventing lateral-user escalation on shared hosts). In web
  // dev mode the Next.js proxy handles credential-less same-origin
  // calls, so no header is needed.
  const authHeaders: Record<string, string> = {};
  if (remoteConfig) {
    authHeaders["Authorization"] = `Bearer ${remoteConfig.token}`;
  } else if (IS_DESKTOP) {
    const token = await getBackendToken();
    authHeaders["Authorization"] = `Bearer ${token}`;
  }

  for (let attempt = 0; attempt <= NETWORK_RETRY_MAX; attempt++) {
    const controller = new AbortController();
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      const res = await fetch(resolvedUrl, {
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": i18n.language || "en",
          ...authHeaders,
          ...fetchOptions.headers,
        },
        ...fetchOptions,
        signal: controller.signal,
      });

      if (!res.ok) {
        const raw = await res.text();
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        throw new ApiError(res.status, res.statusText, body);
      }

      // Handle 204 No Content
      if (res.status === 204) return undefined as T;

      return res.json() as Promise<T>;
    } catch (err) {
      if (didTimeout) {
        throw new Error(`Request timed out while contacting ${url}`);
      }

      // Only retry network errors (TypeError = connection refused/reset/failed).
      // Do NOT retry HTTP errors (ApiError) — those are business-level errors.
      if (err instanceof TypeError && attempt < NETWORK_RETRY_MAX) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        // Re-resolve URL in case backend restarted on a new port
        // (Remote mode: URL is stable via tunnel, no re-resolve needed)
        if (!remoteConfig && IS_DESKTOP) {
          const backend = await getBackendUrl();
          resolvedUrl = url.startsWith("http") ? url : `${backend}${url}`;
        }
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export const api = {
  get: <T>(url: string, options?: ApiRequestInit) => request<T>(url, options),

  post: <T>(url: string, data?: unknown, options?: ApiRequestInit) =>
    request<T>(url, {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
      ...options,
    }),

  put: <T>(url: string, data: unknown, options?: ApiRequestInit) =>
    request<T>(url, {
      method: "PUT",
      body: JSON.stringify(data),
      ...options,
    }),

  patch: <T>(url: string, data: unknown, options?: ApiRequestInit) =>
    request<T>(url, {
      method: "PATCH",
      body: JSON.stringify(data),
      ...options,
    }),

  delete: <T>(url: string, options?: ApiRequestInit) =>
    request<T>(url, { method: "DELETE", ...options }),

  deleteWithBody: <T>(url: string, data: unknown, options?: ApiRequestInit) =>
    request<T>(url, {
      method: "DELETE",
      body: JSON.stringify(data),
      ...options,
    }),
};

import { errorToMessage } from "@/lib/errors";

/**
 * Extract a user-readable message from an ApiError (or any error). Handles
 * string detail, array-form FastAPI 422 detail, and falls back gracefully.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return errorToMessage(err, fallback);
}

export { ApiError };
