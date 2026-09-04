import type { PermissionDetails, PermissionRequest } from '../../shared/protocol.ts'

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** The fallback consumes ACP fields, not provider tool names or Markdown guesses. */
export function permissionPresentation(request: PermissionRequest) {
  const tool = object(request.tool_call)
  const files: PermissionDetails['files'] = []
  if (Array.isArray(tool.content)) {
    for (const entry of tool.content) {
      const block = object(entry)
      if (block.type === 'diff' && typeof block.path === 'string') {
        files.push({ path: block.path,
          ...(typeof block.oldText === 'string' ? { before: block.oldText } : {}),
          ...(typeof block.newText === 'string' ? { after: block.newText } : {}),
        })
      }
    }
  }
  if (Array.isArray(tool.locations)) {
    for (const location of tool.locations) {
      const { path } = object(location)
      if (typeof path === 'string' && !files.some(file => file.path === path)) files.push({ path })
    }
  }
  const input = tool.rawInput ?? tool.raw_input
  const details: PermissionDetails = request.details ?? { kind: files.length ? 'files' : 'tool', files, input }
  const cancel = request.options.find(option => option.kind === 'cancel')
  const options = request.options.filter(option => option.kind !== 'cancel')
  return { details, options, cancelOptionId: cancel?.id ?? null, cancelLabel: cancel?.label ?? 'Cancel',
    initialOptionId: options.find(option => option.kind === 'allow_once')?.id ?? null }
}
