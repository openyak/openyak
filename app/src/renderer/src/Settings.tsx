import type { Agent, AgentId, AgentStatus, ThemePreference } from '../../shared/protocol'

interface Props {
  agents: Agent[]
  enabled: Record<AgentId, boolean>
  defaultProvider: AgentId
  statusByAgent: Partial<Record<AgentId, AgentStatus | null>>
  scanning: boolean
  providerChangesLocked: boolean
  theme: ThemePreference
  onEnabledChange: (id: AgentId, enabled: boolean) => void
  onDefaultChange: (id: AgentId) => void
  onRescan: () => void
  onOpenSetup: (id: AgentId) => void
  onThemeChange: (theme: ThemePreference) => void
}

function providerDescription(agent: Agent) {
  if (!agent.available) return `Install ${agent.name} and sign in before using it in OpenYak.`
  return `Uses your existing ${agent.name} login, tools, and permissions.`
}

function providerStatus(
  agent: Agent,
  enabled: boolean,
  status: AgentStatus | null | undefined,
) {
  if (!agent.available) return 'Not installed'
  if (!enabled) return 'Disabled'
  if (status?.state === 'starting') return 'Starting…'
  if (status?.state === 'exited') return 'Needs attention'
  if (status?.state === 'ready') return 'Ready'
  return 'Installed'
}

export function Settings({
  agents,
  enabled,
  defaultProvider,
  statusByAgent,
  scanning,
  providerChangesLocked,
  theme,
  onEnabledChange,
  onDefaultChange,
  onRescan,
  onOpenSetup,
  onThemeChange,
}: Props) {
  const defaultChoices = agents.filter((agent) => agent.available && enabled[agent.id])

  return (
    <div className="settings-page">
      <div className="settings-content">
        <h1>General</h1>

        <section className="settings-section" aria-labelledby="settings-appearance-heading">
          <h2 id="settings-appearance-heading">Appearance</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-copy">
                <strong>Theme</strong>
                <span>Choose how OpenYak looks.</span>
              </div>
              <div className="settings-segmented" aria-label="Theme">
                {(['system', 'light', 'dark'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className={theme === choice ? 'selected' : ''}
                    data-tooltip-ignore="true"
                    aria-pressed={theme === choice}
                    onClick={() => onThemeChange(choice)}
                  >
                    {choice[0].toUpperCase() + choice.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-defaults-heading">
          <h2 id="settings-defaults-heading">Defaults</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-copy">
                <strong>Default provider</strong>
                <span>Used for new chats until you choose a different provider.</span>
              </div>
              <div className="settings-segmented" aria-label="Default provider">
                {agents.map((agent) => {
                  const selectable = defaultChoices.some((choice) => choice.id === agent.id)
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={defaultProvider === agent.id ? 'selected' : ''}
                      data-tooltip-ignore="true"
                      aria-pressed={defaultProvider === agent.id}
                      disabled={!selectable}
                      onClick={() => onDefaultChange(agent.id)}
                    >
                      {agent.id === 'claude' ? 'Claude' : 'Codex'}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-local-heading">
          <h2 id="settings-local-heading">Local providers</h2>
          <div className="settings-card">
            {agents.map((agent) => {
              const isEnabled = enabled[agent.id]
              const status = statusByAgent[agent.id]
              const statusLabel = providerStatus(agent, isEnabled, status)
              return (
                <div className="settings-row provider-row" key={agent.id}>
                  <div className="settings-copy">
                    <strong>{agent.name}</strong>
                    <span>{providerDescription(agent)}</span>
                    {status?.state === 'exited' && status.detail && (
                      <span className="provider-error">{status.detail}</span>
                    )}
                  </div>
                  <div className="provider-control">
                    <span
                      className={`provider-status${status?.state === 'exited' ? ' is-error' : ''}`}
                    >
                      {statusLabel}
                    </span>
                    {agent.available ? (
                      <button
                        type="button"
                        role="switch"
                        className={`settings-switch${isEnabled ? ' is-on' : ''}`}
                        aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${agent.name}`}
                        aria-checked={isEnabled}
                        disabled={providerChangesLocked}
                        onClick={() => onEnabledChange(agent.id, !isEnabled)}
                      >
                        <span className="settings-switch-knob" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="settings-action"
                        data-tooltip-ignore="true"
                        onClick={() => onOpenSetup(agent.id)}
                      >
                        Setup guide
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            <div className="settings-row">
              <div className="settings-copy">
                <strong>Rescan providers</strong>
                <span>Check again after installing or signing in to a local CLI.</span>
              </div>
              <button
                type="button"
                className={`settings-action settings-rescan${scanning ? ' is-loading' : ''}`}
                data-tooltip-ignore="true"
                disabled={scanning}
                aria-busy={scanning}
                aria-label={scanning ? 'Rescanning providers' : 'Rescan providers'}
                onClick={onRescan}
              >
                {scanning ? (
                  <span className="settings-action-spinner" aria-hidden="true" />
                ) : (
                  'Rescan'
                )}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
