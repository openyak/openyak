import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconClose, IconWarning } from './icons'
import { draggedScrollPosition } from './diagramPresentation'

interface Props {
  mimeType: string
  data: string
  index: number
}

interface ImageSize {
  width: number
  height: number
}

const extensionForMimeType = (mimeType: string) =>
  ({
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/vnd.microsoft.icon': 'ico',
    'image/x-icon': 'ico',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
  })[mimeType] ?? 'img'

function ImageFullscreen({
  src,
  mimeType,
  data,
  index,
  naturalSize,
  onClose,
}: Props & { src: string; naturalSize: ImageSize | null; onClose: () => void }) {
  const [zoom, setZoom] = useState(1)
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const [dragging, setDragging] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveTimer = useRef<number | null>(null)
  const drag = useRef<{
    pointerId: number
    origin: { x: number; y: number }
    scroll: { left: number; top: number }
  } | null>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    }
  }, [onClose])

  const resetSaveStateLater = () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => setSaveState('idle'), 1800)
  }

  const download = async () => {
    if (saveState === 'saving') return
    setSaveState('saving')
    try {
      const extension = extensionForMimeType(mimeType)
      const saved = await window.openyak.saveImage({
        mimeType,
        data,
        suggestedName: `attached-image-${index + 1}.${extension}`,
      })
      setSaveState(saved ? 'saved' : 'idle')
      if (saved) resetSaveStateLater()
    } catch {
      setSaveState('error')
      resetSaveStateLater()
    }
  }

  const downloadLabel =
    saveState === 'saved'
      ? 'Image saved'
      : saveState === 'error'
        ? 'Couldn’t save image'
        : 'Download image'

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return
    drag.current = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      scroll: { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop },
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    event.preventDefault()
  }

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = drag.current
    if (!session || session.pointerId !== event.pointerId) return
    const next = draggedScrollPosition(session.scroll, session.origin, {
      x: event.clientX,
      y: event.clientY,
    })
    event.currentTarget.scrollLeft = next.left
    event.currentTarget.scrollTop = next.top
    event.preventDefault()
  }

  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    drag.current = null
    setDragging(false)
  }

  const fallbackSize = { width: Math.min(viewport.width * 0.72, 1220), height: viewport.height * 0.64 }
  const sourceSize = naturalSize ?? fallbackSize
  const fit = Math.min(
    1,
    Math.max(1, viewport.width - 96) / sourceSize.width,
    Math.max(1, viewport.height - 180) / sourceSize.height,
  )
  const displaySize = {
    width: Math.max(1, Math.round(sourceSize.width * fit * zoom)),
    height: Math.max(1, Math.round(sourceSize.height * fit * zoom)),
  }

  return createPortal(
    <div className="mermaid-modal image-preview-modal" role="dialog" aria-modal="true" aria-label="Image preview">
      <div className="mermaid-modal-actions">
        <button
          type="button"
          className={`mermaid-modal-action${saveState === 'error' ? ' is-error' : ''}`}
          onClick={() => void download()}
          disabled={saveState === 'saving'}
          aria-label={downloadLabel}
          title={downloadLabel}
        >
          {saveState === 'saved' ? (
            <IconCheck size={18} />
          ) : saveState === 'error' ? (
            <IconWarning size={18} />
          ) : (
            <DownloadSimple size={18} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="mermaid-modal-action"
          onClick={onClose}
          aria-label="Close image"
          title="Close image"
          autoFocus
        >
          <IconClose size={18} />
        </button>
      </div>
      <div
        className={`mermaid-modal-canvas${dragging ? ' is-dragging' : ''}`}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        aria-label="Draggable image canvas"
      >
        <div className="mermaid-modal-stage">
          <div className="image-preview-frame" style={displaySize}>
            <img src={src} alt={`Attached image ${index + 1}`} draggable={false} />
          </div>
        </div>
      </div>
      <div className="mermaid-zoom" aria-label="Image zoom controls">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          disabled={zoom <= 0.5}
          aria-label="Zoom out"
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
          disabled={zoom >= 3}
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
    </div>,
    document.body,
  )
}

export function AttachmentImage({ mimeType, data, index }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [naturalSize, setNaturalSize] = useState<ImageSize | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const src = `data:${mimeType};base64,${data}`
  const alt = `Attached image ${index + 1}`

  const close = () => {
    setExpanded(false)
    window.requestAnimationFrame(() => trigger.current?.focus())
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="attach-image-preview-button"
        onClick={() => setExpanded(true)}
        aria-label={`Open ${alt.toLowerCase()}`}
        title="Open image"
      >
        <img
          src={src}
          alt={alt}
          onLoad={(event) =>
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
      </button>
      {expanded && (
        <ImageFullscreen
          mimeType={mimeType}
          data={data}
          index={index}
          src={src}
          naturalSize={naturalSize}
          onClose={close}
        />
      )}
    </>
  )
}
