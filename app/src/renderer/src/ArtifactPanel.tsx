import type { ArtifactPreview } from '../../shared/protocol'
import { FilePreviewContent } from './FilePreviewContent'
import { IconClose, IconFolder } from './icons'

interface Props {
  artifact: ArtifactPreview
  onClose: () => void
  onOpen: () => void
  onReveal: () => void
  onOpenPublished?: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ArtifactPanel({ artifact, onClose, onOpen, onReveal, onOpenPublished }: Props) {
  return (
    <>
      <header className="workbench-toolbar">
        <div className="workbench-breadcrumbs" title={artifact.path}>
          <span><span className="is-current">{artifact.name}</span></span>
          {artifact.version && <span className="artifact-version">v{artifact.version}</span>}
        </div>
        <div className="workbench-actions artifact-actions">
          <span>{formatSize(artifact.size)}</span>
          {onOpenPublished && <button type="button" className="workbench-open" onClick={onOpenPublished}>Published</button>}
          <button type="button" className="icon-btn small" onClick={onReveal} aria-label="Reveal in Finder" title="Reveal in Finder">
            <IconFolder size={15} />
          </button>
          <button type="button" className="workbench-open" onClick={onOpen}>Open</button>
          <button type="button" className="icon-btn small workbench-close" onClick={onClose} aria-label="Close artifact preview">
            <IconClose size={14} />
          </button>
        </div>
      </header>
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
    </>
  )
}
