import { ArrowsOutSimpleIcon as ArrowsOutSimple } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple'
import { CodeIcon as Code } from '@phosphor-icons/react/dist/csr/Code'
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple'
import {
  createContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useContext,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { Components } from 'react-markdown'
import { IconCheck, IconClose, IconCopy, IconWarning } from './icons'
import {
  diagramOverflows,
  diagramViewBoxSize,
  draggedScrollPosition,
  inlineDiagramStyle,
} from './diagramPresentation'
import { codeBlockPresentation, type CodeBlockPresentation } from './markdownPresentation'
import type { ProjectFileReference, ResolvedProjectFile } from '../../shared/protocol'
import { inlineFileReference, markdownFileReference } from './fileReferencePresentation'

interface ProjectFileReferenceContextValue {
  taskId: string
  onOpen: (reference: ProjectFileReference) => void
}

const ProjectFileReferenceContext = createContext<ProjectFileReferenceContextValue | null>(null)

export function ProjectFileReferenceProvider({
  taskId,
  onOpen,
  children,
}: {
  taskId: string | null
  onOpen: (reference: ProjectFileReference) => void
  children: ReactNode
}) {
  const value = useMemo(
    () => (taskId ? { taskId, onOpen } : null),
    [onOpen, taskId],
  )
  return (
    <ProjectFileReferenceContext.Provider value={value}>
      {children}
    </ProjectFileReferenceContext.Provider>
  )
}

function MarkdownFileLink({
  href,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'a'>, 'href'> & { href?: string }) {
  const context = useContext(ProjectFileReferenceContext)
  const reference = href ? markdownFileReference(href) : null
  if (!reference) {
    const sameDocument = href?.startsWith('#')
    return (
      <a {...props} href={href} target={sameDocument ? undefined : '_blank'} rel={sameDocument ? undefined : 'noreferrer'}>
        {children}
      </a>
    )
  }
  return (
    <a
      {...props}
      href={href}
      className={`${props.className ?? ''} md-file-link`.trim()}
      aria-disabled={!context}
      onClick={(event) => {
        event.preventDefault()
        if (context) context.onOpen(reference)
      }}
    >
      {children}
    </a>
  )
}

function MarkdownInlineCode({ children, className, ...props }: React.ComponentPropsWithoutRef<'code'>) {
  const context = useContext(ProjectFileReferenceContext)
  const element = useRef<HTMLElement>(null)
  const text = typeof children === 'string' ? children.replace(/\n$/, '') : ''
  const candidate = inlineFileReference(text)
  const taskId = context?.taskId
  const candidatePath = candidate?.path
  const candidateLine = candidate?.line
  const candidateColumn = candidate?.column
  const lookupKey = taskId && candidatePath
    ? `${taskId}\0${candidatePath}\0${candidateLine ?? ''}\0${candidateColumn ?? ''}`
    : null
  const [resolution, setResolution] = useState<{
    key: string
    file: ResolvedProjectFile | null
  } | null>(null)
  const resolved = resolution?.key === lookupKey ? resolution.file : null

  useEffect(() => {
    let current = true
    if (!taskId || !candidatePath || !lookupKey || element.current?.closest('pre')) {
      return () => { current = false }
    }
    void window.openyak.resolveProjectFile(taskId, {
      path: candidatePath,
      ...(candidateLine ? { line: candidateLine } : {}),
      ...(candidateColumn ? { column: candidateColumn } : {}),
    })
      .then((file) => {
        if (current) setResolution({ key: lookupKey, file })
      })
      .catch(() => {
        if (current) setResolution({ key: lookupKey, file: null })
      })
    return () => { current = false }
  }, [candidateColumn, candidateLine, candidatePath, lookupKey, taskId])

  if (resolved && context && candidate) {
    const location = `${resolved.relativePath}${resolved.line ? `:${resolved.line}` : ''}${resolved.column ? `:${resolved.column}` : ''}`
    return (
      <button
        type="button"
        className="md-inline-file"
        title={`Open ${location}`}
        onClick={() => context.onOpen(candidate)}
      >
        {children}
      </button>
    )
  }
  return <code {...props} ref={element} className={className}>{children}</code>
}

type HastNode = {
  type?: string
  tagName?: string
  value?: unknown
  children?: HastNode[]
  properties?: Record<string, unknown>
}

function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text' && typeof node.value === 'string') return node.value
  return node.children?.map(hastText).join('') ?? ''
}

function codeBlockFromPre(node: HastNode | undefined): {
  source: string
  presentation: CodeBlockPresentation
} | null {
  const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
  if (!code) return null
  const classes = code.properties?.className
  const className = Array.isArray(classes)
    ? classes.filter((value): value is string => typeof value === 'string').join(' ')
    : typeof classes === 'string'
      ? classes
      : undefined
  return {
    source: hastText(code).replace(/\n$/, ''),
    presentation: codeBlockPresentation(className),
  }
}

function ClipboardButton({ value, className = '' }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      const input = document.createElement('textarea')
      input.value = value
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      const copiedWithFallback = document.execCommand('copy')
      input.remove()
      if (!copiedWithFallback) return
      setCopied(true)
    }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button
      type="button"
      className={`markdown-block-action ${className}`.trim()}
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </button>
  )
}

function CodeBlock({
  source,
  presentation,
  children,
}: {
  source: string
  presentation: CodeBlockPresentation
  children: ReactNode
}) {
  return (
    <figure className="markdown-code-block">
      <figcaption className="markdown-code-header">
        <span className="markdown-code-language">
          <Code size={16} weight="bold" aria-hidden="true" />
          {presentation.label}
        </span>
        <ClipboardButton value={source} />
      </figcaption>
      <div className="markdown-code-scroll">{children}</div>
    </figure>
  )
}

export function useDarkAppearance(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return dark
}

let mermaidQueue = Promise.resolve()

function enqueueMermaid<T>(task: () => Promise<T>): Promise<T> {
  const result = mermaidQueue.then(task, task)
  mermaidQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function renderMermaid(source: string, id: string, dark: boolean): Promise<string> {
  return enqueueMermaid(async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      darkMode: dark,
      htmlLabels: false,
      fontFamily:
        "'Nunito Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif",
      themeVariables: dark
        ? {
            darkMode: true,
            background: '#202020',
            primaryColor: '#343434',
            primaryTextColor: '#f4f3e8',
            primaryBorderColor: '#a6a6a1',
            secondaryColor: '#2b2b2b',
            secondaryTextColor: '#f4f3e8',
            secondaryBorderColor: '#8f948f',
            tertiaryColor: '#202020',
            tertiaryTextColor: '#f4f3e8',
            tertiaryBorderColor: '#676b68',
            lineColor: '#b8b8b2',
            textColor: '#f4f3e8',
            noteBkgColor: '#343434',
            noteTextColor: '#f4f3e8',
            noteBorderColor: '#a6a6a1',
          }
        : {
            darkMode: false,
            background: '#fffdf1',
            primaryColor: '#f1ead7',
            primaryTextColor: '#101314',
            primaryBorderColor: '#727b78',
            secondaryColor: '#f4f3e8',
            secondaryTextColor: '#101314',
            secondaryBorderColor: '#727b78',
            tertiaryColor: '#fffdf1',
            tertiaryTextColor: '#101314',
            tertiaryBorderColor: '#a8aaa2',
            lineColor: '#3f4544',
            textColor: '#101314',
            noteBkgColor: '#f1ead7',
            noteTextColor: '#101314',
            noteBorderColor: '#727b78',
          },
      flowchart: { useMaxWidth: true },
      sequence: { useMaxWidth: true },
    })
    const { svg } = await mermaid.render(id, source)
    return svg
  })
}

function DiagramSvg({
  svg,
  className = '',
  style,
}: {
  svg: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={`mermaid-svg ${className}`.trim()}
      style={style}
      aria-label="Rendered Mermaid diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function MermaidFullscreen({
  svg,
  source,
  onClose,
}: {
  svg: string
  source: string
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(1)
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
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
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
      const saved = await window.openyak.saveDiagram(svg)
      setSaveState(saved ? 'saved' : 'idle')
      if (saved) resetSaveStateLater()
    } catch {
      setSaveState('error')
      resetSaveStateLater()
    }
  }

  const downloadLabel =
    saveState === 'saved'
      ? 'Diagram saved'
      : saveState === 'error'
        ? 'Couldn’t save diagram'
        : 'Download diagram'

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

  return createPortal(
    <div className="mermaid-modal" role="dialog" aria-modal="true" aria-label="Diagram preview">
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
          aria-label="Close diagram"
          title="Close diagram"
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
        aria-label="Draggable diagram canvas"
      >
        <div className="mermaid-modal-stage">
          <div
            className="mermaid-modal-sheet"
            style={{
              width: `min(${Math.round(zoom * 88)}vw, ${Math.round(zoom * 1220)}px)`,
            }}
          >
            <DiagramSvg svg={svg} />
          </div>
        </div>
      </div>
      <div className="mermaid-zoom" aria-label="Diagram zoom controls">
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
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
          disabled={zoom >= 2}
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
      <span className="sr-only">{source}</span>
    </div>,
    document.body,
  )
}

function MermaidDiagram({ source }: { source: string }) {
  const dark = useDarkAppearance()
  const reactId = useId()
  const inlineCanvas = useRef<HTMLDivElement>(null)
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const renderKey = `${dark ? 'dark' : 'light'}:${source}`
  const [rendered, setRendered] = useState({ key: '', svg: '', error: false })
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const svg = rendered.key === renderKey ? rendered.svg : ''
  const error = rendered.key === renderKey && rendered.error

  useEffect(() => {
    let cancelled = false
    void renderMermaid(source, renderId, dark)
      .then((result) => {
        if (!cancelled) setRendered({ key: renderKey, svg: result, error: false })
      })
      .catch(() => {
        if (!cancelled) setRendered({ key: renderKey, svg: '', error: true })
      })
    return () => {
      cancelled = true
    }
  }, [dark, renderId, renderKey, source])

  useEffect(() => {
    const canvas = inlineCanvas.current
    const naturalWidth = diagramViewBoxSize(svg)?.width
    if (!canvas || naturalWidth == null) return

    let frame = 0
    const update = () => {
      const style = window.getComputedStyle(canvas)
      const horizontalPadding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      const availableWidth = Math.max(0, canvas.clientWidth - horizontalPadding)
      setOverflowing((current) => {
        const next = diagramOverflows(naturalWidth, availableWidth)
        return current === next ? current : next
      })
    }
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(update)
    }

    // A freshly rendered diagram should always start from its fitted, centred position.
    canvas.scrollLeft = 0
    canvas.scrollTop = 0
    scheduleUpdate()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate)
    observer?.observe(canvas)
    if (canvas.parentElement) observer?.observe(canvas.parentElement)
    if (!observer) window.addEventListener('resize', scheduleUpdate)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      if (!observer) window.removeEventListener('resize', scheduleUpdate)
    }
  }, [svg])

  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-title">Couldn’t render this diagram</div>
        <CodeBlock source={source} presentation={codeBlockPresentation('language-mermaid')}>
          <pre>
            <code>{source}</code>
          </pre>
        </CodeBlock>
      </div>
    )
  }

  return (
    <figure className="mermaid-block" data-mermaid-overflow={overflowing ? '' : undefined}>
      <div className="mermaid-inline-actions">
        {svg && overflowing && (
          <button
            type="button"
            className="markdown-block-action"
            onClick={() => setExpanded(true)}
            aria-label="Open diagram"
            title="Open diagram"
          >
            <ArrowsOutSimple size={16} aria-hidden="true" />
          </button>
        )}
        <ClipboardButton value={source} />
      </div>
      {svg ? (
        !expanded && (
          <div className="mermaid-inline-scroll" ref={inlineCanvas}>
            <DiagramSvg
              svg={svg}
              className="mermaid-inline-svg"
              style={inlineDiagramStyle(svg)}
            />
          </div>
        )
      ) : (
        <div className="mermaid-loading" role="status">
          Rendering diagram…
        </div>
      )}
      {expanded && <MermaidFullscreen svg={svg} source={source} onClose={() => setExpanded(false)} />}
    </figure>
  )
}

export const markdownComponents: Components = {
  a: ({ node, ...props }) => {
    void node
    return <MarkdownFileLink {...props} />
  },
  code: ({ node, ...props }) => {
    void node
    return <MarkdownInlineCode {...props} />
  },
  pre: ({ node, children }) => {
    const block = codeBlockFromPre(node as HastNode | undefined)
    if (!block) return <pre>{children}</pre>
    if (block.presentation.diagram) return <MermaidDiagram source={block.source} />
    return (
      <CodeBlock source={block.source} presentation={block.presentation}>
        <pre>{children}</pre>
      </CodeBlock>
    )
  },
}
