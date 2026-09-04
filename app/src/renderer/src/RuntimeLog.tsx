import { useState } from 'react'
import { request } from './api'

/** Raw event history is paginated and loaded only when explicitly inspected. */
export function RuntimeLog({ taskId }: { taskId: string }) {
  const [events, setEvents] = useState<Record<string, unknown>[]>([])
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    if (busy) return
    setBusy(true)
    try {
      const page = await request<{
        events: Record<string, unknown>[]
        next_cursor: number
      }>('runtime.events', { task_id: taskId, after: cursor, limit: 50 })
      setEvents((old) => [...old, ...page.events])
      setCursor(page.next_cursor)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="runtime-log"
      onToggle={(e) => {
        if (e.currentTarget.open && !events.length) void load()
      }}
    >
      <summary>Agent event log</summary>
      {events.map((event, index) => (
        <details key={index}>
          <summary>
            {String(event.provider)} · {String(event.sequence)}
          </summary>
          <pre>{JSON.stringify(event, null, 2)}</pre>
        </details>
      ))}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? 'Loading…' : 'Load more'}
      </button>
    </details>
  )
}
