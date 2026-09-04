import type { ProjectFilePreview } from '../../shared/protocol'
import { FilePreviewContent } from './FilePreviewContent'

export function ProjectFilePanel({ file, onOpen }: { file: ProjectFilePreview; onOpen: () => void }) {
  return (
    <FilePreviewContent
      name={file.name}
      extension={file.extension}
      previewUrl={file.previewUrl}
      content={file.content}
      renderedHtml={file.renderedHtml}
      truncated={file.truncated}
      line={file.line}
      column={file.column}
      onOpen={onOpen}
    />
  )
}
