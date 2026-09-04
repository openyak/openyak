import type { Part } from '../../shared/protocol'

export interface AssistantPartPresentation {
  workParts: Part[]
  visibleParts: Part[]
}

export type ToolPart = Extract<Part, { type: 'tool_call' }>
export type WorkNarrativePart = Extract<
  Part,
  { type: 'text' } | { type: 'thought' } | { type: 'error' }
>

export type ToolActivityKind =
  | 'read'
  | 'search'
  | 'view'
  | 'edit'
  | 'load'
  | 'execute'
  | 'compaction'
  | 'other'

export interface WorkActivity {
  kind: ToolActivityKind
  tools: ToolPart[]
  label: string
}

export type WorkTimelineEntry =
  | { type: 'narrative'; part: WorkNarrativePart; partIndex: number }
  | { type: 'activity'; activity: WorkActivity; partIndex: number }

export function isContextCompaction(part: Part): boolean {
  return (
    part.type === 'tool_call' &&
    part._meta != null &&
    Object.prototype.hasOwnProperty.call(part._meta, 'contextCompaction')
  )
}

export function contextCompactionLabel(part: ToolPart): string {
  return part.status === 'pending' || part.status === 'in_progress'
    ? 'Context automatically compacting'
    : 'Context automatically compacted'
}

export function shouldExposeToolOutput(part: ToolPart): boolean {
  return !isContextCompaction(part) && Boolean(part.output)
}

export function isToolActive(part: ToolPart): boolean {
  return part.status === 'pending' || part.status === 'in_progress'
}

export function hasActiveTool(parts: Part[]): boolean {
  return parts.some((part) => part.type === 'tool_call' && isToolActive(part))
}

export function toolActivityKind(part: ToolPart): ToolActivityKind {
  if (isContextCompaction(part)) return 'compaction'
  const kind = part.kind.toLowerCase()
  const title = part.title.trim().toLowerCase()
  if (kind === 'execute') return 'execute'
  if (kind.includes('search') || /^(search|find|grep|rg)\b/.test(title)) return 'search'
  if (kind.includes('image') || /^(view|inspect).*(image|screenshot)/.test(title)) return 'view'
  if (kind.includes('read') || /^(read|open)\b/.test(title)) return 'read'
  if (kind.includes('edit') || /^(edit|write|create|patch|update)\b/.test(title)) return 'edit'
  if (kind.includes('load') || /^load(ed|ing)?\b/.test(title)) return 'load'
  return 'other'
}

function activityPhrase(kind: ToolActivityKind, count: number, active = false): string {
  switch (kind) {
    case 'read':
      return `${active ? 'Reading' : 'Read'} ${count === 1 ? 'a file' : `${count} files`}`
    case 'search':
      return active ? 'Searching' : count === 1 ? 'Searched' : `Searched ${count} times`
    case 'view':
      return `${active ? 'Viewing' : 'Viewed'} ${count === 1 ? 'an image' : `${count} images`}`
    case 'edit':
      return `${active ? 'Editing' : 'Edited'} ${count === 1 ? 'a file' : `${count} files`}`
    case 'load':
      return `${active ? 'Loading' : 'Loaded'} ${count === 1 ? 'a tool' : `${count} tools`}`
    case 'execute':
      return `${active ? 'Running' : 'Ran'} ${count === 1 ? 'a command' : `${count} commands`}`
    case 'compaction':
      return 'Context automatically compacted'
    case 'other':
      return `${active ? 'Using' : 'Used'} ${count === 1 ? 'a tool' : `${count} tools`}`
  }
}

export function describeToolGroup(tools: ToolPart[]): string {
  const order: ToolActivityKind[] = []
  const counts = new Map<ToolActivityKind, number>()
  for (const tool of tools) {
    const kind = toolActivityKind(tool)
    if (!counts.has(kind)) order.push(kind)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return order
    .map((kind, index) => {
      const matchingTools = tools.filter((tool) => toolActivityKind(tool) === kind)
      const active = matchingTools.some(isToolActive)
      const phrase = activityPhrase(kind, counts.get(kind) ?? 0, active)
      return index === 0 ? phrase : phrase[0].toLowerCase() + phrase.slice(1)
    })
    .join(', ')
}

/**
 * Build the disclosure in transport order. Codex groups only adjacent, groupable tool
 * events; prose, reasoning summaries, errors, and compaction markers are boundaries.
 */
export function buildWorkTimeline(parts: Part[]): WorkTimelineEntry[] {
  const entries: WorkTimelineEntry[] = []
  let pendingTools: ToolPart[] = []
  let pendingIndex = -1

  const flushTools = () => {
    if (pendingTools.length === 0) return
    entries.push({
      type: 'activity',
      activity: {
        kind: toolActivityKind(pendingTools[0]),
        tools: pendingTools,
        label: describeToolGroup(pendingTools),
      },
      partIndex: pendingIndex,
    })
    pendingTools = []
    pendingIndex = -1
  }

  parts.forEach((part, partIndex) => {
    if (part.type === 'tool_call' && !isContextCompaction(part)) {
      if (pendingTools.length === 0) pendingIndex = partIndex
      pendingTools.push(part)
      return
    }

    flushTools()
    if (part.type === 'tool_call') {
      entries.push({
        type: 'activity',
        activity: {
          kind: 'compaction',
          tools: [part],
          label: contextCompactionLabel(part),
        },
        partIndex,
      })
      return
    }
    if (part.type === 'text' || part.type === 'thought' || part.type === 'error') {
      entries.push({ type: 'narrative', part, partIndex })
    }
  })
  flushTools()
  return entries
}

export function normalizeThoughtText(text: string): string {
  return text.trim()
}

/** Reveal bursty provider deltas over a few frames without falling far behind. */
export function streamingRevealStep(current: string, target: string): string {
  if (!target.startsWith(current)) return target
  const remaining = target.length - current.length
  if (remaining <= 2) return target
  const step = remaining > 1000 ? 32 : remaining > 240 ? 16 : remaining > 80 ? 8 : remaining > 24 ? 4 : 2
  let end = Math.min(target.length, current.length + step)
  const previous = target.charCodeAt(end - 1)
  const next = target.charCodeAt(end)
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1
  return target.slice(0, end)
}

/** A live Part can already contain many batched IPC deltas on its first React commit. */
export function initialStreamingText(text: string, live: boolean): string {
  return live ? '' : text
}

/** React Strict Mode replays effects; release the handle as well as cancelling the frame. */
export function cancelStreamingFrame(
  frame: { current: number | null },
  cancelFrame: (id: number) => void,
): void {
  if (frame.current !== null) cancelFrame(frame.current)
  frame.current = null
}

/** Keep completed Markdown blocks stable; the unfinished tail is the only hot render region. */
export function splitStableStreamingText(text: string): { stable: string; tail: string } {
  let fence: '`' | '~' | null = null
  let offset = 0
  let stableEnd = 0
  for (const line of text.split(/(?<=\n)/)) {
    const trimmed = line.trimStart()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (fence == null) fence = marker
      else if (fence === marker) fence = null
    }
    offset += line.length
    if (fence == null && /^\s*$/.test(line) && line.includes('\n')) stableEnd = offset
  }
  return { stable: text.slice(0, stableEnd), tail: text.slice(stableEnd) }
}

export function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  if (totalSeconds < 1) return '<1s'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

export function summarizeWorkDetails(durationMs: number | null | undefined, streaming: boolean): string {
  const verb = streaming ? 'Working' : 'Worked'
  return durationMs == null ? verb : `${verb} for ${formatWorkDuration(durationMs)}`
}

export function shouldShowWorkStatus(workParts: Part[], streaming: boolean): boolean {
  return streaming || workParts.length > 0
}

export function textPhase(part: Part): string | null {
  if (part.type !== 'text' || part._meta == null) return null
  const codex = part._meta.codex
  if (typeof codex !== 'object' || codex == null || Array.isArray(codex)) return null
  const phase = (codex as Record<string, unknown>).phase
  return typeof phase === 'string' ? phase : null
}

/** Use provider phase metadata when available; otherwise retain the legacy live fallback. */
export function partitionAssistantParts(
  parts: Part[],
  streaming: boolean,
): AssistantPartPresentation {
  if (streaming) {
    const finalAnswerIndex = parts.findIndex((part) => textPhase(part) === 'final_answer')
    if (finalAnswerIndex >= 0) {
      return {
        workParts: parts.slice(0, finalAnswerIndex),
        visibleParts: parts.slice(finalAnswerIndex).filter((part) => part.type !== 'thought'),
      }
    }

    // Codex labels its prose phases. Keep commentary and activities in one live,
    // chronological disclosure until the final-answer phase begins.
    if (parts.some((part) => textPhase(part) != null)) {
      return { workParts: parts, visibleParts: [] }
    }

    // Thought contents remain private. Keep one generic Thinking indicator only while
    // the newest Part is still a thought; completed thought phases should not accumulate.
    const visibleParts = parts.filter(
      (part, index) => part.type !== 'thought' || index === parts.length - 1,
    )
    return { workParts: [], visibleParts }
  }

  const lastWorkIndex = parts.findLastIndex(
    (part) => part.type === 'tool_call' || part.type === 'thought',
  )
  if (lastWorkIndex < 0) return { workParts: [], visibleParts: parts }

  return {
    workParts: parts.slice(0, lastWorkIndex + 1),
    visibleParts: parts.slice(lastWorkIndex + 1),
  }
}
