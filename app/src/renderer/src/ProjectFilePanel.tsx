import type { ProjectFilePreview } from '../../shared/protocol'
import { IconChevronRight, IconClose, IconFolder } from './icons'
import { FilePreviewContent } from './FilePreviewContent'

interface Props {
  file: ProjectFilePreview
  projectName?: string
  onClose: () => void
  onOpen: () => void
  onReveal: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ProjectFilePanel({ file, projectName, onClose, onOpen, onReveal }: Props) {
  const breadcrumbs = [projectName, ...file.relativePath.split(/[\\/]/)].filter(Boolean)

  return (
    <>
      <header className="workbench-toolbar">
        <nav className="workbench-breadcrumbs" aria-label="File path" title={file.path}>
          {breadcrumbs.map((part, index) => (
            <span key={`${part}:${index}`}>
              {index > 0 && <IconChevronRight size={11} />}
              <span className={index === breadcrumbs.length - 1 ? 'is-current' : undefined}>{part}</span>
            </span>
          ))}
        </nav>
        <div className="workbench-actions">
          <span>{formatSize(file.size)}</span>
          <button type="button" className="icon-btn small" onClick={onReveal} aria-label="Reveal in Finder" title="Reveal in Finder">
            <IconFolder size={15} />
          </button>
          <button type="button" className="workbench-open" onClick={onOpen}>Open</button>
          <button type="button" className="icon-btn small workbench-close" onClick={onClose} aria-label="Close file preview">
            <IconClose size={14} />
          </button>
        </div>
      </header>
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
    </>
  )
}
