import {
  memo,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Attachment, Message, Part } from '../../shared/protocol'
import {
  draftsFromFiles,
  draftsFromParts,
  draftsFromPaths,
  mergeDrafts,
  toAttachment,
  type AttachmentDraft,
} from './attachmentDrafts'
import {
  IconBookOpen,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconEdit,
  IconFile,
  IconImage,
  IconPlay,
  IconPlus,
  IconRetry,
  IconSearch,
  IconTerminal,
  IconTextShorter,
  IconTools,
  IconWarning,
} from './icons'
import {
  buildWorkTimeline,
  cancelStreamingFrame,
  contextCompactionLabel,
  describeToolGroup,
  hasActiveTool,
  initialStreamingText,
  isContextCompaction,
  isToolActive,
  partitionAssistantParts,
  shouldShowWorkStatus,
  shouldExposeToolOutput,
  summarizeWorkDetails,
  splitStableStreamingText,
  streamingRevealStep,
  toolActivityKind,
  type WorkActivity,
  type ToolPart,
} from './messagePresentation'

interface Props {
  message: Message
  /** Display name of the agent that produced an assistant message. */
  agentName: string | null
  busy: boolean
  latest: boolean
  editing: boolean
  onEdit: (message: Message) => void
  onCancelEdit: () => void
  onSubmitEdit: (message: Message, text: string, attachments: Attachment[]) => Promise<boolean>
  onRetry: (message: Message) => void
  onContinue: () => void
}

// Links open in the user's browser (the main process denies in-app navigation).
const components: Components = {
  a: ({ node, ...props }) => {
    void node
    return <a {...props} target="_blank" rel="noreferrer" />
  },
}

type TextPart = Extract<Part, { type: 'text' }>
type ImagePart = Extract<Part, { type: 'image' }>
type FilePart = Extract<Part, { type: 'file' }>

export function MessageItem({
  message,
  agentName,
  busy,
  latest,
  editing,
  onEdit,
  onCancelEdit,
  onSubmitEdit,
  onRetry,
  onContinue,
}: Props) {
  // Parts arrive by index and can be sparse for a moment.
  const parts = message.parts.filter((p): p is Part => Boolean(p))

  if (message.role === 'user') {
    const text = parts
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('')
    const images = parts.filter((p): p is ImagePart => p.type === 'image')
    const files = parts.filter((p): p is FilePart => p.type === 'file')
    return (
      <div className="msg msg-user">
        <div className={`msg-user-content${editing ? ' is-editing' : ''}`}>
          {editing ? (
            <InlineMessageEditor
              message={message}
              parts={parts}
              text={text}
              onCancel={onCancelEdit}
              onSubmit={onSubmitEdit}
            />
          ) : (
            <>
              <div className="msg-user-stack">
                {images.length > 0 && (
                  <div className="attach-images">
                    {images.map((p, i) => (
                      <img
                        key={i}
                        src={`data:${p.mime_type};base64,${p.data}`}
                        alt={`Attached image ${i + 1}`}
                      />
                    ))}
                  </div>
                )}
                {files.length > 0 && (
                  <div className="attach-files">
                    {files.map((p, i) => (
                      <span key={i} className="attach-chip" title={p.path}>
                        <IconFile size={13} />
                        {p.name}
                      </span>
                    ))}
                  </div>
                )}
                {text && <div className="bubble">{text}</div>}
              </div>
              <div className="msg-actions msg-user-actions">
                {text && <CopyAction text={text} label="Copy message" />}
                <button
                  type="button"
                  className="msg-action"
                  onClick={() => onEdit(message)}
                  disabled={busy}
                  aria-label="Edit message"
                  title={busy ? 'Stop the current response before editing' : 'Edit message'}
                >
                  <IconEdit size={15} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  const streaming = message.status === 'streaming'
  const { workParts, visibleParts } = partitionAssistantParts(parts, streaming)
  const showWorkStatus = shouldShowWorkStatus(workParts, streaming)
  const copyableText = visibleParts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
  return (
    <div className={`msg msg-assistant status-${message.status}`}>
      {agentName && <div className="msg-agent">{agentName}</div>}
      <div className="msg-body">
        {showWorkStatus && (
          <WorkDetails
            message={message}
            parts={workParts}
            active={streaming && visibleParts.length === 0}
          />
        )}
        {visibleParts.map((part, index) => {
          const originalIndex = parts.indexOf(part)
          const key = part.type === 'tool_call' ? `tool:${part.id}` : `${part.type}:${originalIndex}`
          return (
            <PartView
              key={key}
              part={part}
              live={streaming && index === visibleParts.length - 1}
            />
          )
        })}
        {streaming && visibleParts.length === 0 && !hasActiveTool(parts) && <ThinkingActivity />}
        {message.status === 'cancelled' && <div className="msg-note">Stopped</div>}
        {!streaming && (
          <div className="msg-actions">
            {copyableText && <CopyAction text={copyableText} label="Copy response" />}
            {message.status === 'cancelled' && (
              <button
                type="button"
                className="msg-action msg-action-wide"
                onClick={onContinue}
                disabled={busy || !latest}
                aria-label="Continue response"
                title={
                  latest
                    ? 'Continue from where the response stopped'
                    : 'Only the latest stopped response can continue'
                }
              >
                <IconPlay size={14} />
                <span>Continue</span>
              </button>
            )}
            <button
              type="button"
              className="msg-action"
              onClick={() => onRetry(message)}
              disabled={busy || !latest}
              aria-label="Retry response"
              title={
                busy
                  ? 'Stop the current response before retrying'
                  : latest
                    ? 'Retry response'
                    : 'Edit the earlier prompt to replay from here'
              }
            >
              <IconRetry size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function InlineMessageEditor({
  message,
  parts,
  text: initialText,
  onCancel,
  onSubmit,
}: {
  message: Message
  parts: Part[]
  text: string
  onCancel: () => void
  onSubmit: (message: Message, text: string, attachments: Attachment[]) => Promise<boolean>
}) {
  const [text, setText] = useState(initialText)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>(() => draftsFromParts(parts))
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const hasContent = text.trim().length > 0 || attachments.length > 0

  const addFiles = (files: Iterable<File>) => {
    if (submittingRef.current) return
    void draftsFromFiles(files).then(({ drafts, notices }) => {
      setAttachments((current) => {
        const merged = mergeDrafts(current, drafts)
        const allNotices = [
          ...notices,
          ...merged.duplicateNames.map((name) => `${name} is already attached`),
        ]
        setNotice(allNotices.length ? allNotices.join('. ') : null)
        return merged.drafts
      })
    })
  }

  const pickFiles = async () => {
    if (submittingRef.current) return
    const paths = await window.openyak.pickFiles()
    if (paths.length === 0) return
    setAttachments((current) => {
      const merged = mergeDrafts(current, draftsFromPaths(paths))
      setNotice(
        merged.duplicateNames.length
          ? `${merged.duplicateNames.length} duplicate attachment${merged.duplicateNames.length === 1 ? ' was' : 's were'} skipped`
          : null,
      )
      return merged.drafts
    })
  }

  const submit = async () => {
    if (!hasContent || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const sent = await onSubmit(message, text.trim(), attachments.map(toAttachment))
      if (sent) return
    } catch {
      // The parent normally reports RPC errors; keep the editor recoverable either way.
    }
    submittingRef.current = false
    setSubmitting(false)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  return (
    <div
      className={`inline-editor${dragging ? ' dragging' : ''}${submitting ? ' is-submitting' : ''}`}
      aria-busy={submitting}
      onDragOver={(event) => {
        event.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={`attach attach-${attachment.type}`}
              title={attachment.type === 'file' ? attachment.path : attachment.name}
            >
              {attachment.type === 'image' ? (
                <img
                  src={`data:${attachment.mime_type};base64,${attachment.data}`}
                  alt={attachment.name}
                />
              ) : (
                <>
                  <IconFile size={14} />
                  <span className="attach-name">{attachment.name}</span>
                </>
              )}
              <button
                type="button"
                className="attach-remove"
                aria-label={`Remove ${attachment.name}`}
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((candidate) => candidate.id !== attachment.id),
                  )
                }
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {notice && (
        <div className="attachment-notice" role="status">
          <IconWarning size={13} />
          <span>{notice}</span>
          <button
            type="button"
            className="icon-btn small"
            onClick={() => setNotice(null)}
            aria-label="Dismiss attachment notice"
          >
            <IconClose size={12} />
          </button>
        </div>
      )}
      <textarea
        autoFocus
        rows={1}
        value={text}
        aria-label="Edit message"
        readOnly={submitting}
        onChange={(event) => setText(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (submitting) return
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className="inline-editor-footer">
        <button
          type="button"
          className="inline-editor-add"
          onClick={() => void pickFiles()}
          disabled={submitting}
          aria-label="Add files"
          title="Add files"
        >
          <IconPlus size={16} />
        </button>
        <div className="inline-editor-actions">
          <button
            type="button"
            className="inline-editor-button"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-editor-button inline-editor-submit"
            onClick={() => void submit()}
            disabled={!hasContent || submitting}
            title="Replace later messages and resend; files on disk stay unchanged"
          >
            <span>Send</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function CopyAction({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard permission failures are intentionally quiet; the control remains usable.
    }
  }
  return (
    <button
      type="button"
      className="msg-action"
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
    </button>
  )
}

function PartView({ part, live }: { part: Part; live: boolean }) {
  switch (part.type) {
    case 'text':
      return <StreamingMarkdown text={part.text} live={live} />
    case 'thought':
      // Keep streaming responsive without exposing the provider's private reasoning.
      return <ThinkingActivity />
    case 'tool_call':
      return (
        <ActivityRow
          activity={{
            kind: toolActivityKind(part),
            tools: [part],
            label: isContextCompaction(part)
              ? contextCompactionLabel(part)
              : describeToolGroup([part]),
          }}
        />
      )
    case 'error':
      return <div className="msg-error">{part.message}</div>
    case 'image':
    case 'file':
      // Attachments belong to user messages; nothing to show on an assistant turn.
      return null
  }
}

const MarkdownFragment = memo(function MarkdownFragment({ text }: { text: string }) {
  if (!text) return null
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {text}
    </Markdown>
  )
})

const MarkdownContent = memo(function MarkdownContent({ text, live }: { text: string; live: boolean }) {
  return (
    <div className={`md${live ? ' md-live' : ''}`}>
      <MarkdownFragment text={text} />
    </div>
  )
})

/** Smooth bursty deltas and keep completed Markdown blocks out of the hot render region. */
function StreamingMarkdown({ text, live }: { text: string; live: boolean }) {
  const initialText = initialStreamingText(text, live)
  const [frameText, setFrameText] = useState(initialText)
  const latestText = useRef(text)
  const renderedText = useRef(initialText)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    latestText.current = text
    if (renderedText.current === latestText.current) return
    if (frame.current !== null) return
    const renderFrame = () => {
      const next = streamingRevealStep(renderedText.current, latestText.current)
      renderedText.current = next
      setFrameText(next)
      if (next === latestText.current) frame.current = null
      else frame.current = requestAnimationFrame(renderFrame)
    }
    frame.current = requestAnimationFrame(renderFrame)
  }, [live, text])

  useEffect(
    () => () => {
      cancelStreamingFrame(frame, cancelAnimationFrame)
    },
    [],
  )

  const visuallyStreaming = live || frameText !== text
  if (!visuallyStreaming) return <MarkdownContent text={text} live={false} />
  const { stable, tail } = splitStableStreamingText(frameText)
  return (
    <div className="md md-live">
      <MarkdownFragment text={stable} />
      <MarkdownFragment text={tail} />
    </div>
  )
}

function ThinkingActivity() {
  return (
    <div className="thinking" role="status" aria-live="polite">
      <span className="thinking-label">Thinking…</span>
    </div>
  )
}

/** Tool output is shown verbatim in a monospace box; a wrapping code fence is noise. */
function unfence(text: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim())
  return m ? m[1] : text
}

function ToolIcon({ part, size = 14 }: { part: ToolPart; size?: number }) {
  const kind = toolActivityKind(part)
  const Icon =
    kind === 'compaction'
      ? IconTextShorter
      : kind === 'execute'
      ? IconTerminal
      : kind === 'search'
        ? IconSearch
        : kind === 'view'
          ? IconImage
          : kind === 'read'
            ? IconBookOpen
            : kind === 'edit'
              ? IconEdit
              : kind === 'load'
                ? IconTools
                : IconFile
  return <Icon size={size} className="tool-icon" />
}

function ToolTitle({ part }: { part: ToolPart }) {
  const command =
    toolActivityKind(part) === 'execute' && !/^(ran|running)\b/i.test(part.title.trim())
  if (!command) return <>{part.title}</>
  const running = part.status === 'pending' || part.status === 'in_progress'
  return (
    <>
      <span className="tool-title-verb">{running ? 'Running' : 'Ran'}</span>
      <code>{part.title}</code>
    </>
  )
}

function ToolCall({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false)
  if (isContextCompaction(part)) {
    const active = part.status === 'pending' || part.status === 'in_progress'
    return (
      <div
        className={`tool-activity-row tool-compaction${active ? ' is-active' : ''}`}
        role="status"
        aria-live="polite"
      >
        <ToolIcon part={part} size={15} />
        <span className="tool-activity-title">{contextCompactionLabel(part)}</span>
      </div>
    )
  }
  const expandable = shouldExposeToolOutput(part)
  const statusLabel =
    part.status === 'failed' ? 'Failed' : null
  return (
    <div className={`tool tool-${part.status}`}>
      <button
        type="button"
        className="tool-row"
        onClick={() => expandable && setOpen((o) => !o)}
        disabled={!expandable}
        aria-label={`${part.title}: ${part.status}${expandable ? '. View output' : ''}`}
        title={expandable ? 'View tool output' : undefined}
      >
        <ToolIcon part={part} />
        <span className="tool-title">
          <ToolTitle part={part} />
        </span>
        <span className="tool-dot" />
        {statusLabel && <span className="tool-status-label">{statusLabel}</span>}
        {expandable && (
          <IconChevronRight size={12} className={`tool-caret${open ? ' open' : ''}`} />
        )}
      </button>
      {open && part.output && <pre className="tool-output">{unfence(part.output)}</pre>}
    </div>
  )
}

function ActivityRow({ activity }: { activity: WorkActivity }) {
  const [open, setOpen] = useState(false)
  const failed = activity.tools.filter((tool) => tool.status === 'failed').length
  const active = activity.tools.some(isToolActive)
  const compaction = activity.kind === 'compaction'
  const expandable = !compaction
  return (
    <div className={`tool-activity${active ? ' is-active' : ''}${failed ? ' has-failure' : ''}`}>
      <button
        type="button"
        className="tool-activity-row"
        disabled={!expandable}
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
      >
        <ToolIcon part={activity.tools[0]} size={15} />
        <span className={`tool-activity-title${active ? ' activity-shimmer' : ''}`}>
          {activity.label}
        </span>
        {failed > 0 && (
          <span className="tool-status-label">{failed === 1 ? '1 failed' : `${failed} failed`}</span>
        )}
        {expandable && (
          <IconChevronRight size={12} className={`tool-caret${open ? ' open' : ''}`} />
        )}
      </button>
      {expandable && (
        <AnimatedDisclosure open={open} className="tool-activity-details">
          {activity.tools.map((tool) => (
            <ToolCall key={tool.id} part={tool} />
          ))}
        </AnimatedDisclosure>
      )}
    </div>
  )
}

function AnimatedDisclosure({
  open,
  className,
  children,
}: {
  open: boolean
  className: string
  children: ReactNode
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    const update = () => setHeight(element.scrollHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (contentRef.current) contentRef.current.inert = !open
  }, [open])

  return (
    <div
      className={`animated-disclosure${open ? ' is-open' : ''}`}
      style={{ height: open ? height : 0 }}
      aria-hidden={!open}
    >
      <div ref={contentRef} className={className}>
        {children}
      </div>
    </div>
  )
}

function elapsedSince(createdAt: string): number {
  const startedAt = Date.parse(createdAt)
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0
}

function WorkDetails({
  message,
  parts,
  active,
}: {
  message: Message
  parts: Part[]
  active?: boolean
}) {
  const streaming = message.status === 'streaming'
  const [liveDuration, setLiveDuration] = useState(() => elapsedSince(message.created_at))
  const [open, setOpen] = useState(Boolean(active))
  const [previousActive, setPreviousActive] = useState(Boolean(active))

  if (Boolean(active) !== previousActive) {
    setPreviousActive(Boolean(active))
    setOpen(Boolean(active))
  }

  useEffect(() => {
    if (!streaming) return
    const update = () => setLiveDuration(elapsedSince(message.created_at))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [message.created_at, streaming])

  const duration = streaming ? liveDuration : message.duration_ms
  const summary = summarizeWorkDetails(duration, streaming)
  const timeline = buildWorkTimeline(parts)

  if (timeline.length === 0) {
    return (
      <div className="work-details work-details-static">
        <div className="work-details-summary" role="status" aria-live="polite">
          {summary}
        </div>
      </div>
    )
  }

  return (
    <div className={`work-details${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="work-details-toggle"
        data-tooltip-ignore="true"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{summary}</span>
        <IconChevronRight size={13} className="work-details-caret" />
      </button>
      <AnimatedDisclosure open={open} className="work-details-body">
        {timeline.map((entry) => {
          if (entry.type === 'activity') {
            return (
              <ActivityRow
                key={`activity:${entry.activity.tools.map((tool) => tool.id).join(':')}`}
                activity={entry.activity}
              />
            )
          }
          const part = entry.part
          if (part.type === 'error') {
            return (
              <div key={`error:${entry.partIndex}`} className="msg-error">
                {part.message}
              </div>
            )
          }
          const content = part.text
          if (!content) return null
          return (
            <div key={`${part.type}:${entry.partIndex}`} className="work-details-narrative md">
              <Markdown remarkPlugins={[remarkGfm]} components={components}>
                {content}
              </Markdown>
            </div>
          )
        })}
      </AnimatedDisclosure>
    </div>
  )
}
