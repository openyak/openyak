import { useEffect, useRef, type ReactNode } from 'react'
import type { Agent, Message, PermissionRequest } from '../../shared/protocol'
import type { PendingPermission } from './App'
import { MessageItem } from './Message'
import { IconHand } from './icons'

interface Props {
  messages: Message[]
  agents: Agent[]
  permission: PendingPermission | null
  onPermission: (optionId: string | null) => void
  /** Shown instead of the list while there are no messages. */
  empty: ReactNode
}

export function Thread({ messages, agents, permission, onPermission, empty }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Follow new content unless the user has scrolled up to read.
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, permission])

  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id

  if (messages.length === 0) return <div className="thread thread-empty">{empty}</div>

  return (
    <div
      className="thread"
      ref={ref}
      onScroll={() => {
        const el = ref.current
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      <div className="thread-inner">
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            agentName={m.role === 'assistant' && m.agent ? name(m.agent) : null}
          />
        ))}
        {permission && (
          <PermissionCard
            request={permission.request}
            agentName={name(permission.request.agent)}
            onChoose={onPermission}
          />
        )}
      </div>
    </div>
  )
}

/** The agent's own permission request, forwarded as is; the answer goes straight back. */
function PermissionCard({
  request,
  agentName,
  onChoose,
}: {
  request: PermissionRequest
  agentName: string
  onChoose: (optionId: string | null) => void
}) {
  return (
    <div className="permission">
      <div className="permission-head">
        <IconHand size={15} />
        <span>{agentName} asks for permission</span>
      </div>
      <div className="permission-title">{request.title}</div>
      <div className="permission-actions">
        {request.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`btn${o.kind.startsWith('allow') ? ' btn-primary' : ''}`}
            title={o.kind}
            onClick={() => onChoose(o.id)}
          >
            {o.label}
          </button>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => onChoose(null)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
