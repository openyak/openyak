import { useState } from 'react'
import type { Message, Part } from '../../shared/protocol'

export function MessageView({ message }: { message: Message }) {
  return (
    <article className={`message message-${message.role} status-${message.status}`}>
      <div className="message-meta">
        <span className="role">{message.role === 'user' ? 'you' : 'assistant'}</span>
        {message.role === 'assistant' && message.agent && (
          <span className="badge">{message.agent}</span>
        )}
        {message.status === 'streaming' && <span className="badge badge-live">streaming</span>}
        {message.status === 'cancelled' && <span className="badge">cancelled</span>}
      </div>
      <div className="parts">
        {message.parts.map((part, i) =>
          part ? <PartView key={i} part={part} /> : null,
        )}
      </div>
    </article>
  )
}

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case 'text':
      return <pre className="part part-text">{part.text}</pre>
    case 'thought':
      return <Collapsible className="part part-thought" summary="thought" body={part.text} />
    case 'tool_call':
      return <ToolCall part={part} />
    case 'error':
      return <div className="part part-error">{part.message}</div>
  }
}

function ToolCall({ part }: { part: Extract<Part, { type: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="part part-tool">
      <button className="tool-row" onClick={() => setOpen((o) => !o)} disabled={!part.output}>
        <span className="tool-kind">{part.kind}</span>
        <span className="tool-title">{part.title}</span>
        <span className={`tool-status tool-status-${part.status}`}>{part.status}</span>
        {part.output && <span className="tool-caret">{open ? '▾' : '▸'}</span>}
      </button>
      {open && part.output && <pre className="tool-output">{part.output}</pre>}
    </div>
  )
}

function Collapsible({
  className,
  summary,
  body,
}: {
  className: string
  summary: string
  body: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={className}>
      <button className="linkish" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {summary}
      </button>
      {open && <pre>{body}</pre>}
    </div>
  )
}
