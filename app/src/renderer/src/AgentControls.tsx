import type { Agent, AgentConfigOption, AgentId, AgentStatus } from '../../shared/protocol'

interface SelectProps {
  agents: Agent[]
  agent: AgentId | null
  disabled: boolean
  onChange: (id: AgentId) => void
}

/** The agent picker in the Chat header: which agent the next message goes to. */
export function AgentSelect({ agents, agent, disabled, onChange }: SelectProps) {
  return (
    <select
      className="agent-select"
      aria-label="Agent"
      value={agent ?? ''}
      disabled={disabled || agents.length === 0}
      onChange={(e) => onChange(e.target.value as AgentId)}
    >
      {agent === null && <option value="">no agent</option>}
      {agents.map((a) => (
        <option key={a.id} value={a.id} disabled={!a.available}>
          {a.available ? a.name : `${a.name} (not installed)`}
        </option>
      ))}
    </select>
  )
}

interface ControlsProps {
  /** The agent's session options; null until the session reports them. */
  options: AgentConfigOption[] | null
  status: AgentStatus | null
  /** Id of the option whose change is in flight, if any. */
  settingConfig: string | null
  onSetConfig: (configId: string, value: string | boolean) => void
}

/**
 * Provider-specific controls (model, effort, mode, …) rendered straight from what the
 * agent advertises over ACP. Choices go back to the agent untouched.
 */
export function AgentControls({ options, status, settingConfig, onSetConfig }: ControlsProps) {
  if (options === null) {
    return (
      <div className="chat-controls">
        <span className="control-hint">{connectingText(status)}</span>
      </div>
    )
  }
  const shown = options.filter((o) => o.type !== 'unknown')
  if (shown.length === 0) return null
  return (
    <div className="chat-controls">
      {shown.map((o) => (
        <ConfigControl
          key={o.id}
          option={o}
          busy={settingConfig === o.id}
          onChange={(value) => onSetConfig(o.id, value)}
        />
      ))}
    </div>
  )
}

function connectingText(status: AgentStatus | null): string {
  switch (status?.state) {
    case 'exited':
      return status.detail ? `agent exited: ${status.detail}` : 'agent exited'
    case 'ready':
      return 'no options'
    default:
      return 'starting agent…'
  }
}

function ConfigControl({
  option,
  busy,
  onChange,
}: {
  option: AgentConfigOption
  busy: boolean
  onChange: (value: string | boolean) => void
}) {
  if (option.type === 'boolean') {
    return (
      <label className="control" title={option.description}>
        <input
          type="checkbox"
          checked={option.current_value}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{option.name}</span>
      </label>
    )
  }
  if (option.type !== 'select') return null

  // Options may come grouped (e.g. models by family); keep the agent's order.
  const groups = new Map<string | undefined, typeof option.options>()
  for (const o of option.options) {
    const list = groups.get(o.group) ?? []
    list.push(o)
    groups.set(o.group, list)
  }
  const render = (list: typeof option.options) =>
    list.map((o) => (
      <option key={o.value} value={o.value} title={o.description}>
        {o.name}
      </option>
    ))
  const current = option.options.find((o) => o.value === option.current_value)

  return (
    <label className="control" title={current?.description ?? option.description}>
      <span>{option.name}</span>
      <select
        value={option.current_value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      >
        {!current && <option value={option.current_value}>{option.current_value}</option>}
        {[...groups.entries()].map(([group, list]) =>
          group === undefined ? (
            render(list)
          ) : (
            <optgroup key={group} label={group}>
              {render(list)}
            </optgroup>
          ),
        )}
      </select>
    </label>
  )
}
