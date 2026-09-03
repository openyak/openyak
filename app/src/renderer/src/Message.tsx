import { useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, Part } from '../../shared/protocol'
import { IconChevronRight, IconFile, IconTerminal } from './icons'

interface Props {
  message: Message
  /** Display name of the agent that produced an assistant message. */
  agentName: string | null
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

export function MessageItem({ message, agentName }: Props) {
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
        <div className="msg-user-stack">
          {images.length > 0 && (
            <div className="attach-images">
              {images.map((p, i) => (
                <img key={i} src={`data:${p.mime_type};base64,${p.data}`} alt="" />
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
      </div>
    )
  }

  const streaming = message.status === 'streaming'
  return (
    <div className={`msg msg-assistant status-${message.status}`}>
      {agentName && <div className="msg-agent">{agentName}</div>}
      <div className="msg-body">
        {parts.map((part, i) => (
          <PartView key={i} part={part} live={streaming && i === parts.length - 1} />
        ))}
        {streaming && parts.length === 0 && (
          <div className="thinking" aria-label="Working">
            <span />
            <span />
            <span />
          </div>
        )}
        {message.status === 'cancelled' && <div className="msg-note">Stopped</div>}
      </div>
    </div>
  )
}

function PartView({ part, live }: { part: Part; live: boolean }) {
  switch (part.type) {
    case 'text':
      return (
        <div className={`md${live ? ' md-live' : ''}`}>
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
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

function ToolCall({ part }: { part: Extract<Part, { type: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)
  const Icon = part.kind === 'execute' ? IconTerminal : IconFile
  const expandable = !!part.output
  return (
    <div className={`tool tool-${part.status}`}>
      <button
        type="button"
        className="tool-row"
        onClick={() => expandable && setOpen((o) => !o)}
        disabled={!expandable}
        title={part.status}
      >
        <Icon size={14} className="tool-icon" />
        <span className="tool-title">{part.title}</span>
        <span className="tool-dot" />
        {expandable && (
          <IconChevronRight size={12} className={`tool-caret${open ? ' open' : ''}`} />
        )}
      </button>
      {open && part.output && <pre className="tool-output">{part.output}</pre>}
    </div>
  )
}
