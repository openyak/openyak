import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
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
  IconCheck,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconEdit,
  IconFile,
  IconPlay,
  IconPlus,
  IconRetry,
  IconTerminal,
  IconWarning,
} from './icons'

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
type ToolPart = Extract<Part, { type: 'tool_call' }>

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
  const lastToolIndex = parts.findLastIndex((part) => part.type === 'tool_call')
  const hasCompletedWork = !streaming && lastToolIndex >= 0
  const workParts = hasCompletedWork ? parts.slice(0, lastToolIndex + 1) : []
  const visibleParts = hasCompletedWork ? parts.slice(lastToolIndex + 1) : parts
  const copyableText = visibleParts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
  return (
    <div className={`msg msg-assistant status-${message.status}`}>
      {agentName && <div className="msg-agent">{agentName}</div>}
      <div className="msg-body">
        {hasCompletedWork && <WorkDetails parts={workParts} />}
        {visibleParts.map((part, i) => (
          <PartView key={i} part={part} live={streaming && i === visibleParts.length - 1} />
        ))}
        {streaming && parts.length === 0 && (
          <div className="thinking" role="status" aria-live="polite">
            <span className="thinking-label">Working</span>
            <span className="thinking-pulse" aria-hidden="true" />
          </div>
        )}
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
      return (
        <div className={`md${live ? ' md-live' : ''}`}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={components}
          >
            {part.text}
          </Markdown>
        </div>
      )
    case 'thought':
      return (
        <details className="thought">
          <summary>
            <IconChevronRight size={12} className="thought-caret" />
            {live ? 'Thinking' : 'Thought'}
          </summary>
          <div className="thought-body">{part.text}</div>
        </details>
      )
    case 'tool_call':
      return <ToolCall part={part} />
    case 'error':
      return <div className="msg-error">{part.message}</div>
    case 'image':
    case 'file':
      // Attachments belong to user messages; nothing to show on an assistant turn.
      return null
  }
}

/** Tool output is shown verbatim in a monospace box; a wrapping code fence is noise. */
function unfence(text: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim())
  return m ? m[1] : text
}

function ToolCall({ part }: { part: Extract<Part, { type: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)
  const Icon = part.kind === 'execute' ? IconTerminal : IconFile
  const expandable = !!part.output
  const statusLabel =
    part.status === 'in_progress' || part.status === 'pending'
      ? 'Running'
      : part.status === 'failed'
        ? 'Failed'
        : null
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
        <Icon size={14} className="tool-icon" />
        <span className="tool-title">{part.title}</span>
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

function WorkDetails({ parts }: { parts: Part[] }) {
  const tools = parts.filter((part): part is ToolPart => part.type === 'tool_call')
  const failed = tools.filter((part) => part.status === 'failed').length
  const pending = tools.filter(
    (part) => part.status === 'pending' || part.status === 'in_progress',
  ).length
  const needsAttention =
    failed > 0 || pending > 0 || parts.some((part) => part.type === 'error')
  const [open, setOpen] = useState(needsAttention)
  const countLabel = `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`

  return (
    <details
      className={`work-details${needsAttention ? ' needs-attention' : ''}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{needsAttention ? 'Work details' : 'Worked'}</span>
        <span className="work-details-count">
          {failed > 0 ? `${failed} failed` : pending > 0 ? `${pending} still running` : countLabel}
        </span>
        <IconChevronRight size={13} className="work-details-caret" />
      </summary>
      <div className="work-details-body">
        {parts.map((part, index) =>
          part.type === 'tool_call' ? (
            <ToolCall key={part.id} part={part} />
          ) : (
            <PartView key={index} part={part} live={false} />
          ),
        )}
      </div>
    </details>
  )
}
