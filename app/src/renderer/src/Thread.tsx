import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Agent, Attachment, Message, PermissionRequest } from '../../shared/protocol'
import type { PendingPermission } from './App'
import { MessageItem } from './Message'
import { IconArrowDown, IconHand } from './icons'

interface Props {
  messages: Message[]
  agents: Agent[]
  busy: boolean
  permission: PendingPermission | null
  onPermission: (optionId: string | null) => void
  editingMessage: Message | null
  onEdit: (message: Message) => void
  onCancelEdit: () => void
  onSubmitEdit: (message: Message, text: string, attachments: Attachment[]) => Promise<boolean>
  onRetry: (message: Message) => void
  onContinue: () => void
  /** Shown instead of the list while there are no messages. */
  empty: ReactNode
}

interface ConversationTurn {
  id: string
  title: string
  preview: string
}

const compact = (value: string, fallback: string, preserveLines = false) => {
  const text = preserveLines
    ? value
        .replace(/\r/g, '')
        .replace(/[*_`]/g, '')
        .replace(/^\s*[-+]\s+/gm, '• ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : value.replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  const limit = preserveLines ? 220 : 110
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function messageSummary(message: Message, preserveLines = false): string {
  if (message.role === 'assistant' && message.status !== 'streaming') {
    const lastToolIndex = message.parts.findLastIndex((part) => part?.type === 'tool_call')
    if (lastToolIndex >= 0) {
      for (let index = lastToolIndex + 1; index < message.parts.length; index += 1) {
        const part = message.parts[index]
        if (part?.type === 'text') return compact(part.text, 'Message', preserveLines)
        if (part?.type === 'error') return part.message
      }
    }
  }
  for (const part of message.parts) {
    if (!part) continue
    if (part.type === 'text') return compact(part.text, 'Message', preserveLines)
    if (part.type === 'file') return part.name
    if (part.type === 'image') return 'Image attachment'
    if (part.type === 'tool_call') return part.title
    if (part.type === 'error') return part.message
    if (part.type === 'thought') return compact(part.text, 'Thinking', preserveLines)
  }
  return message.status === 'streaming' ? 'Working…' : 'Message'
}

export function Thread({
  messages,
  agents,
  busy,
  permission,
  onPermission,
  editingMessage,
  onEdit,
  onCancelEdit,
  onSubmitEdit,
  onRetry,
  onContinue,
  empty,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  // Follow new content unless the user has scrolled up to read.
  const stick = useRef(true)
  const positioned = useRef(false)
  const previousCount = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const [showMinimap, setShowMinimap] = useState(false)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null)

  const turns = useMemo<ConversationTurn[]>(() => {
    const result: ConversationTurn[] = []
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role !== 'user') continue
      let reply: Message | undefined
      for (let next = index + 1; next < messages.length; next += 1) {
        if (messages[next].role === 'user') break
        if (messages[next].role === 'assistant') {
          reply = messages[next]
          break
        }
      }
      result.push({
        id: message.id,
        title: messageSummary(message),
        preview: reply ? messageSummary(reply, true) : 'Waiting for a response…',
      })
    }
    return result
  }, [messages])

  const updateMinimap = useCallback(() => {
    const scroller = ref.current
    const inner = innerRef.current
    if (!scroller || !inner) {
      setShowMinimap(false)
      setActiveTurnId(null)
      return
    }
    const longEnough = turns.length >= 2 && scroller.scrollHeight - scroller.clientHeight > 240
    setShowMinimap((current) => (current === longEnough ? current : longEnough))
    if (!longEnough) {
      setActiveTurnId(null)
      return
    }

    const probe = scroller.scrollTop + Math.min(scroller.clientHeight * 0.35, 240)
    let active = turns[0]?.id ?? null
    for (const turn of turns) {
      const node = inner.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(turn.id)}"]`)
      if (!node) continue
      const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      if (top > probe) break
      active = turn.id
    }
    setActiveTurnId((current) => (current === active ? current : active))
  }, [turns])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const firstContent = !positioned.current && messages.length > 0
    const addedMessage = messages.length > previousCount.current
    const newest = messages[messages.length - 1]
    // Sending a message is an explicit return to the live edge. Token updates only
    // follow when the reader was already there.
    if (addedMessage && newest?.role === 'assistant') {
      const userBeforeIt = messages[messages.length - 2]
      if (userBeforeIt?.role === 'user') stick.current = true
    }
    if (stick.current) {
      if (firstContent || !addedMessage) {
        // Token chunks already arrive as small increments. Jumping to each new edge keeps
        // them visually continuous; restarting smooth scrolling per chunk causes stutter.
        el.scrollTop = el.scrollHeight
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      }
    }
    if (messages.length > 0) positioned.current = true
    previousCount.current = messages.length
    const frame = requestAnimationFrame(updateMinimap)
    return () => cancelAnimationFrame(frame)
  }, [messages, permission, updateMinimap])

  useEffect(() => {
    const scroller = ref.current
    const inner = innerRef.current
    if (!scroller || !inner) return
    const observer = new ResizeObserver(updateMinimap)
    observer.observe(scroller)
    observer.observe(inner)
    updateMinimap()
    return () => observer.disconnect()
  }, [updateMinimap])

  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id
  const minimapNaturalHeight = Math.max(18, (turns.length - 1) * 10 + 8)
  const activeTurnIndex = turns.findIndex((turn) => turn.id === activeTurnId)
  const hoveredTurnIndex = turns.findIndex((turn) => turn.id === hoveredTurnId)
  const focalTurnIndex = hoveredTurnIndex >= 0 ? hoveredTurnIndex : activeTurnIndex

  return (
    <div className="thread-shell">
      <div
        className={`thread${messages.length === 0 ? ' thread-empty' : ''}`}
        ref={ref}
        aria-busy={messages.some((message) => message.status === 'streaming')}
        onScroll={() => {
          const el = ref.current
          if (!el) return
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          setShowJump(!stick.current)
          updateMinimap()
        }}
      >
        {messages.length === 0 ? (
          empty
        ) : (
          <div className="thread-inner" ref={innerRef}>
            {messages.map((m, index) => (
              <div key={m.id} className="thread-message" data-message-id={m.id}>
                <MessageItem
                  message={m}
                  busy={busy}
                  latest={index === messages.length - 1}
                  editing={editingMessage?.id === m.id}
                  onEdit={onEdit}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={onSubmitEdit}
                  onRetry={onRetry}
                  onContinue={onContinue}
                />
              </div>
            ))}
            {permission && (
              <PermissionCard
                request={permission.request}
                agentName={name(permission.request.agent)}
                onChoose={onPermission}
              />
            )}
          </div>
        )}
      </div>
      {showMinimap && (
        <nav
          className="conversation-minimap"
          aria-label="Conversation map"
          style={{ height: `min(${minimapNaturalHeight}px, 54vh, 420px)` }}
        >
          <div className="conversation-minimap-track">
            {turns.map((turn, index) => {
              const distance = focalTurnIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - focalTurnIndex)
              return (
                <button
                  key={turn.id}
                  type="button"
                  data-tooltip-ignore="true"
                  className={`conversation-minimap-mark${turn.id === activeTurnId ? ' is-active' : ''}${turn.id === hoveredTurnId ? ' is-hovered' : ''}${distance === 1 ? ' is-near-1' : ''}${distance === 2 ? ' is-near-2' : ''}${index === 0 ? ' is-first' : ''}${index === turns.length - 1 ? ' is-last' : ''}`}
                  style={{ top: `${((4 + index * 10) / minimapNaturalHeight) * 100}%` }}
                  aria-label={`Jump to: ${turn.title}`}
                  aria-current={turn.id === activeTurnId ? 'location' : undefined}
                  onPointerEnter={() => setHoveredTurnId(turn.id)}
                  onPointerLeave={() => setHoveredTurnId(null)}
                  onFocus={() => setHoveredTurnId(turn.id)}
                  onBlur={() => setHoveredTurnId(null)}
                  onClick={() => {
                    const scroller = ref.current
                    const node = innerRef.current?.querySelector<HTMLElement>(
                      `[data-message-id="${CSS.escape(turn.id)}"]`,
                    )
                    if (!scroller || !node) return
                    stick.current = false
                    const top =
                      node.getBoundingClientRect().top -
                      scroller.getBoundingClientRect().top +
                      scroller.scrollTop
                    scroller.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' })
                  }}
                >
                  <span className="conversation-minimap-line" />
                  <span className="conversation-minimap-tooltip">
                    <strong>{turn.title}</strong>
                    <span>{turn.preview}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </nav>
      )}
      {showJump && (
        <button
          type="button"
          className="jump-latest"
          aria-label="Jump to latest message"
          title="Jump to latest"
          onClick={() => {
            const el = ref.current
            if (!el) return
            stick.current = true
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            setShowJump(false)
          }}
        >
          <IconArrowDown size={17} />
        </button>
      )}
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
