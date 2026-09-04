import type { ArtifactEventData, ArtifactReference, Part } from '../../shared/protocol'

const autoPreviewExtensions = new Set([
  'avif',
  'bmp',
  'gif',
  'htm',
  'html',
  'jpeg',
  'jpg',
  'markdown',
  'md',
  'pdf',
  'png',
  'svg',
  'webp',
])

export interface PresentedArtifact {
  key: string
  kind: string
  operation: string
  artifact: ArtifactReference
}

const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const reference = (value: unknown): ArtifactReference | null => {
  const candidate = record(value)
  if (!candidate) return null
  const artifact: ArtifactReference = {}
  for (const key of [
    'id',
    'path',
    'url',
    'title',
    'version',
    'contract',
    'audience',
    'live_subscription',
  ] as const) {
    if (typeof candidate[key] === 'string') artifact[key] = candidate[key]
  }
  if ('capabilities' in candidate) artifact.capabilities = candidate.capabilities
  return artifact.path || artifact.url ? artifact : null
}

/** Consume only the common artifact event contract; provider envelopes stay opaque. */
export function artifactsFromParts(parts: Part[]): PresentedArtifact[] {
  const found: PresentedArtifact[] = []
  for (const part of parts) {
    if (part.type !== 'event' || !part.kind.startsWith('artifact.')) continue
    const data = record(part.data) as ArtifactEventData | null
    if (!data || data.schema_version !== 1 || typeof data.tool_call_id !== 'string') continue
    const references = [data.artifact, ...(Array.isArray(data.artifacts) ? data.artifacts : [])]
      .map(reference)
      .filter((artifact): artifact is ArtifactReference => artifact !== null)
    for (const artifact of references) {
      found.push({
        key: `${data.tool_call_id}:${artifact.id ?? artifact.url ?? artifact.path}:${artifact.version ?? ''}`,
        kind: part.kind,
        operation: typeof data.operation === 'string' ? data.operation : '',
        artifact,
      })
    }
  }
  return found
}

export function artifactName(artifact: ArtifactReference): string {
  if (artifact.title) return artifact.title
  if (artifact.path) {
    return artifact.path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || artifact.path
  }
  if (artifact.url) {
    try {
      return new URL(artifact.url).pathname.split('/').filter(Boolean).at(-1) || artifact.url
    } catch {
      return artifact.url
    }
  }
  return 'Artifact'
}

/** Automatically present only local, presentation-shaped outputs. */
export function shouldAutoPreviewArtifact(artifact: ArtifactReference): boolean {
  if (!artifact.path) return false
  const extension = artifact.path.split('.').at(-1)?.toLowerCase() ?? ''
  return autoPreviewExtensions.has(extension)
}
