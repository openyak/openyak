import type { ArtifactPreview } from '../../shared/protocol'
import { FilePreviewContent } from './FilePreviewContent'

export function ArtifactPanel({ artifact, onOpen }: { artifact: ArtifactPreview; onOpen: () => void }) {
  return (
    <FilePreviewContent
      name={artifact.name}
      extension={artifact.extension}
      previewUrl={artifact.previewUrl}
      content={artifact.content}
      renderedHtml={artifact.renderedHtml}
      truncated={artifact.truncated}
      trustedArtifact
      onOpen={onOpen}
    />
  )
}
