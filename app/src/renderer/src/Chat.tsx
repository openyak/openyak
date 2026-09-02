import { useEffect, useRef } from 'react'
import type { Agent, AgentId, Message, Task } from '../../shared/protocol'
import type { PendingPermission } from './App'
import { MessageView } from './MessageView'
import { Composer } from './Composer'
import { PermissionBar } from './PermissionBar'

interface Props {
  task: Task | null
  agents: Agent[]
  messages: Message[]
  permission: PendingPermission | null
  onSend: (agent: AgentId, text: string) => void
  onCancel: () => void
  onPermission: (optionId: string | null) => void
}

export function Chat({ task, agents, messages, permission, onSend, onCancel, onPermission }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const streaming = messages.some((m) => m.status === 'streaming')

  // Keep the newest content in view while streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  return (
    <section className="column column-chat">
      <header className="column-header">
        <h2>{task ? task.title : 'Chat'}</h2>
      </header>
      <div className="messages" ref={scrollRef}>
        {task && messages.length === 0 && <div className="empty">No messages yet.</div>}
        {!task && <div className="empty">Select a task.</div>}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
      </div>
      {permission && <PermissionBar request={permission.request} onChoose={onPermission} />}
      <Composer
        agents={agents}
        disabled={!task}
        streaming={streaming}
        onSend={onSend}
        onCancel={onCancel}
      />
    </section>
  )
}
