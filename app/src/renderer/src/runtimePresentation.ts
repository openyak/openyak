import type { Part } from '../../shared/protocol'

export interface ChildAgent {
  id: string
  parentId?: string
  name: string
  status: string
  model?: string
  activities: unknown[]
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
/** Only normalized events are interpreted here. No provider tool names or prose. */
export function childAgents(parts: Part[]): ChildAgent[] {
  const children = new Map<string, ChildAgent>()
  for (const part of parts) {
    if (part.type !== 'event' || part.kind !== 'agent.updated') continue
    const data = record(part.data)
    if (typeof data.id !== 'string') continue
    const old = children.get(data.id)
    children.set(data.id, {
      id: data.id,
      parentId:
        typeof data.parentId === 'string' ? data.parentId : old?.parentId,
      name: typeof data.name === 'string' ? data.name : old?.name || data.id,
      status:
        typeof data.status === 'string'
          ? data.status
          : old?.status || 'unknown',
      model: typeof data.model === 'string' ? data.model : old?.model,
      activities: data.activity
        ? [...(old?.activities ?? []), data.activity]
        : (old?.activities ?? []),
    })
  }
  return [...children.values()]
}
