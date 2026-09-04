import type { ArtifactReference, Part } from '../../shared/protocol'
import { artifactsFromParts } from './artifactPresentation.ts'

export interface FileOutput {
  key: string
  kind: 'artifact' | 'file'
  reference: ArtifactReference
}

/** Only common host events are renderable; provider tool payloads remain opaque. */
export function fileOutputsFromParts(parts: Part[]): FileOutput[] {
  const outputs = new Map<string, FileOutput>()
  for (const [index, part] of parts.entries()) {
    if (part.type !== 'event') continue
    for (const item of artifactsFromParts([part])) {
      outputs.set(`artifact:${item.key}`, { key: `artifact:${item.key}`, kind: 'artifact', reference: item.artifact })
    }
    if (part.kind !== 'file.output') continue
    const data = part.data as { schema_version?: unknown; tool_call_id?: unknown; files?: unknown } | null
    if (data?.schema_version !== 1 || typeof data.tool_call_id !== 'string' || !Array.isArray(data.files)) continue
    for (const file of data.files) {
      if (!file || typeof file.path !== 'string' || !file.path || file.path.includes('\0')) continue
      outputs.delete(`file:${file.path}`)
      outputs.set(`file:${file.path}`, { key: `file:${data.tool_call_id}:${index}:${file.path}`, kind: 'file', reference: { path: file.path } })
    }
  }
  return [...outputs.values()]
}
