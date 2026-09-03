/** Compact relative time for the sidebar: "now", "4m", "3h", "2d", "1w", then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'now'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h`
  const d = h / 24
  if (d < 7) return `${Math.floor(d)}d`
  const w = d / 7
  if (w < 5) return `${Math.floor(w)}w`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A Task title from the first message: its first line, trimmed to fit the sidebar. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!line) return 'New chat'
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line
}
