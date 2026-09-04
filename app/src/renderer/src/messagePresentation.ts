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

function isActiveTool(part: Part): boolean {
  return (
    part.type === 'tool_call' &&
    (part.status === 'pending' || part.status === 'in_progress')
  )
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

function activityPhrase(kind: ToolActivityKind, count: number): string {
  switch (kind) {
    case 'read':
      return `Read ${count === 1 ? 'a file' : `${count} files`}`
    case 'search':
      return count === 1 ? 'Searched' : `Searched ${count} times`
    case 'view':
      return `Viewed ${count === 1 ? 'an image' : `${count} images`}`
    case 'edit':
      return `Edited ${count === 1 ? 'a file' : `${count} files`}`
    case 'load':
      return `Loaded ${count === 1 ? 'a tool' : `${count} tools`}`
    case 'execute':
      return `Ran ${count === 1 ? 'a command' : `${count} commands`}`
    case 'compaction':
      return 'Context automatically compacted'
    case 'other':
      return `Used ${count === 1 ? 'a tool' : `${count} tools`}`
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
      const phrase = activityPhrase(kind, counts.get(kind) ?? 0)
      return index === 0 ? phrase : phrase[0].toLowerCase() + phrase.slice(1)
    })
    .join(', ')
}

export function groupWorkParts(parts: Part[]): WorkActivity[] {
  // Work details are a user-facing activity summary, not a transport log. Thoughts and
  // intermediate prose stay in the stored message but never become rows here.
  const order: Array<ToolActivityKind | WorkActivity> = []
  const groups = new Map<ToolActivityKind, ToolPart[]>()
  for (const part of parts) {
    if (part.type !== 'tool_call') continue
    const kind = toolActivityKind(part)
    if (kind === 'compaction') {
      order.push({ kind, tools: [part], label: contextCompactionLabel(part) })
      continue
    }
    if (!groups.has(kind)) order.push(kind)
    groups.set(kind, [...(groups.get(kind) ?? []), part])
  }

  return order.map((entry) => {
    if (typeof entry !== 'string') return entry
    const kind = entry
    const tools = groups.get(kind) ?? []
    return { kind, tools, label: describeToolGroup(tools) }
  })
}

export function workNarrativeParts(parts: Part[]): WorkNarrativePart[] {
  return parts.filter(
    (part): part is WorkNarrativePart =>
      part.type === 'text' || part.type === 'thought' || part.type === 'error',
  )
}

export function normalizeThoughtText(text: string): string {
  return text.trim()
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

/** Keep completed work summarized while exposing only the current streaming activity. */
export function partitionAssistantParts(
  parts: Part[],
  streaming: boolean,
): AssistantPartPresentation {
  const lastWorkIndex = parts.findLastIndex(
    (part) => part.type === 'tool_call' || part.type === 'thought',
  )
  if (lastWorkIndex < 0) return { workParts: [], visibleParts: parts }

  if (!streaming) {
    return {
      workParts: parts.slice(0, lastWorkIndex + 1),
      visibleParts: parts.slice(lastWorkIndex + 1),
    }
  }

  const trailingParts = parts.slice(lastWorkIndex + 1)
  if (trailingParts.length > 0) {
    return {
      workParts: parts.slice(0, lastWorkIndex + 1),
      visibleParts: trailingParts,
    }
  }

  const activeIndex = parts.findLastIndex(isActiveTool)
  // A provider often marks a tool completed before it emits the next thought/tool.
  // Keep that most recent activity visible across the gap instead of flashing an empty
  // response. An actually running tool wins over a later out-of-order completion.
  const currentIndex = activeIndex >= 0 ? activeIndex : lastWorkIndex
  const workParts = parts
    .slice(0, lastWorkIndex + 1)
    .filter((_, index) => index !== currentIndex)
  const visibleParts = [parts[currentIndex]]

  return { workParts, visibleParts }
}
