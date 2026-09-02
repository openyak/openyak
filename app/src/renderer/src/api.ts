// Thin wrapper over window.openyak.request with dev-only logging.
export async function request<T>(method: string, params: unknown = {}): Promise<T> {
  if (import.meta.env.DEV) console.log(`[rpc →] ${method}`, JSON.stringify(params))
  try {
    const result = await window.openyak.request<T>(method, params)
    if (import.meta.env.DEV) console.log(`[rpc ←] ${method}`, JSON.stringify(result))
    return result
  } catch (err) {
    if (import.meta.env.DEV) console.log(`[rpc ✕] ${method}`, String(err))
    throw err
  }
}
