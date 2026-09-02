import { useState } from 'react'
import type { Agent, AgentId } from '../../shared/protocol'

interface Props {
  agents: Agent[]
  disabled: boolean
  streaming: boolean
  onSend: (agent: AgentId, text: string) => void
  onCancel: () => void
}

export function Composer({ agents, disabled, streaming, onSend, onCancel }: Props) {
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<AgentId | null>(null)

  const available = agents.filter((a) => a.available)
  const agent =
    chosen && available.some((a) => a.id === chosen) ? chosen : (available[0]?.id ?? null)
  const canSend = !disabled && !streaming && agent !== null && text.trim().length > 0

  const submit = () => {
    if (!canSend || !agent) return
    onSend(agent, text.trim())
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        rows={3}
        placeholder={disabled ? 'Select a task to start' : 'Message… (Enter to send, Shift+Enter for newline)'}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-row">
        <div className="segmented" role="radiogroup" aria-label="Agent">
          {agents.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={a.id === agent}
              className={a.id === agent ? 'on' : ''}
              disabled={!a.available || disabled}
              title={a.available ? a.command : 'Install and log in to Claude Code / Codex'}
              onClick={() => setChosen(a.id)}
            >
              {a.name}
            </button>
          ))}
          {agents.length === 0 && <span className="empty">no agents</span>}
        </div>
        <div className="composer-actions">
          <button onClick={onCancel} disabled={!streaming}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={!canSend}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
