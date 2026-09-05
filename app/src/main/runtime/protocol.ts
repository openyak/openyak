import type { Part } from '../../shared/protocol'

export type ObjectValue = Record<string, unknown>
export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {}
}
export function array(value: unknown): ObjectValue[] {
  return Array.isArray(value) ? value.map(object) : []
}
export function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
export interface OpenParams {
  taskId?: string
  browserMcpUrl?: string
  cwd: string
  sessionId?: string
  config?: Record<string, unknown>
}
export interface RuntimeSink {
  part(key: string, part: Part): void
  event(type: string, data: unknown, sourceSessionId?: string): void
  request(
    method: 'permission.request' | 'elicitation.request',
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
  config(options: unknown[]): void
}
export interface NativeDriver {
  open(params: OpenParams): Promise<{ sessionId: string }>
  prompt(input: ObjectValue[]): Promise<ObjectValue>
  configure(id: string, value: unknown): Promise<void>
  cancel(): Promise<void>
  close(): void
}
export function selectOption(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: { value: string; name: string }[],
) {
  return { id, name, category, type: 'select', currentValue, options }
}

/** Provider-specific question schemas end here; the renderer only sees a form. */
export function questionForm(questions: ObjectValue[]) {
  const properties = Object.fromEntries(
    questions.map((q, i) => {
      const key = string(q.id) || string(q.question) || String(i)
      const options = array(q.options)
      return [
        key,
        {
          type: q.multiSelect ? 'array' : 'string',
          title: string(q.question) || string(q.header),
          description: options
            .map(
              (o) =>
                `${string(o.label)}${o.description ? `: ${string(o.description)}` : ''}`,
            )
            .join('\n'),
          // A free-text field supports both the provider's options and custom answers.
          ...(q.multiSelect
            ? {
                items: {
                  type: 'string',
                  enum: options.map((o) => string(o.label)),
                },
              }
            : {}),
        },
      ]
    }),
  )
  return {
    mode: 'form',
    message: 'Please answer to continue',
    requestedSchema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
    },
  }
}
