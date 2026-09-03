import { useEffect, useRef } from 'react'
import type {
  Agent,
  AgentConfigOption,
  AgentId,
  AgentStatus,
  Message,
  Task,
} from '../../shared/protocol'
import type { PendingPermission } from './App'
import { AgentControls, AgentSelect } from './AgentControls'
import { MessageView } from './MessageView'
import { Composer } from './Composer'
import { PermissionBar } from './PermissionBar'

interface Props {
  task: Task | null
  agents: Agent[]
  /** Agent the next message goes to; null when none is installed. */
  agent: AgentId | null
  onAgentChange: (id: AgentId) => void
  options: AgentConfigOption[] | null
  status: AgentStatus | null
  settingConfig: string | null
  onSetConfig: (configId: string, value: string | boolean) => void
  messages: Message[]
  permission: PendingPermission | null
  onSend: (text: string) => void
  onCancel: () => void
  onPermission: (optionId: string | null) => void
}

export function Chat({
  task,
  agents,
  agent,
  onAgentChange,
  options,
  status,
  settingConfig,
  onSetConfig,
  messages,
  permission,
  onSend,
  onCancel,
  onPermission,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const streaming = messages.some((m) => m.status === 'streaming')

  // Keep the newest content in view while streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const placeholder = !task
    ? 'Select a task to start'
    : !agent
      ? 'Install and log in to Claude Code or Codex to chat'
      : 'Ask anything…'

  return (
    <section className="column column-chat">
      <header className="column-header">
        <h2>{task ? task.title : 'Chat'}</h2>
        <AgentSelect agents={agents} agent={agent} disabled={!task} onChange={onAgentChange} />
      </header>
      {task && agent && (
        <AgentControls
          options={options}
          status={status}
          settingConfig={settingConfig}
          onSetConfig={onSetConfig}
        />
      )}
      <div className="messages" ref={scrollRef}>
        {task && messages.length === 0 && <div className="empty">No messages yet.</div>}
        {!task && <div className="empty">Select a task.</div>}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
      </div>
      {permission && <PermissionBar request={permission.request} onChoose={onPermission} />}
      <Composer
        disabled={!task || !agent}
        placeholder={placeholder}
        streaming={streaming}
        onSend={onSend}
        onCancel={onCancel}
      />
    </section>
  )
}
