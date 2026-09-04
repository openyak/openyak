import { useCallback, useEffect, useState } from 'react'
import type {
  Agent,
  AgentId,
  AgentStatus,
  CodexHostCapabilities,
  ThemePreference,
} from '../../shared/protocol'

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
  projectPath: string | null
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
  projectPath,
}: Props) {
  const defaultChoices = agents.filter((agent) => agent.available && enabled[agent.id])
  const [capabilities, setCapabilities] = useState<CodexHostCapabilities | null>(null)
  const [capabilityError, setCapabilityError] = useState<string | null>(null)
  const [loadingCapabilities, setLoadingCapabilities] = useState(false)
  const [changingCapability, setChangingCapability] = useState<string | null>(null)

  const refreshCapabilities = useCallback(async () => {
    setLoadingCapabilities(true)
    setCapabilityError(null)
    try {
      setCapabilities(await window.openyak.codexCapabilities(projectPath))
    } catch (error) {
      setCapabilityError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingCapabilities(false)
    }
  }, [projectPath])

  useEffect(() => {
    if (!agents.some((agent) => agent.id === 'codex' && agent.available)) return
    const timer = window.setTimeout(() => void refreshCapabilities(), 0)
    return () => window.clearTimeout(timer)
  }, [agents, refreshCapabilities])

  const mutate = async (key: string, action: () => Promise<unknown>) => {
    setChangingCapability(key)
    setCapabilityError(null)
    try {
      await action()
      await refreshCapabilities()
    } catch (error) {
      setCapabilityError(error instanceof Error ? error.message : String(error))
    } finally {
      setChangingCapability(null)
    }
  }

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

        {agents.some((agent) => agent.id === 'codex' && agent.available) && (
          <section className="settings-section" aria-labelledby="settings-codex-host-heading">
            <div className="settings-section-heading">
              <div>
                <h2 id="settings-codex-host-heading">Codex host capabilities</h2>
                <p>Loaded from the official Codex App Server and your installed configuration.</p>
              </div>
              <button
                type="button"
                className={`settings-action settings-rescan${loadingCapabilities ? ' is-loading' : ''}`}
                disabled={loadingCapabilities || changingCapability !== null}
                onClick={() => void refreshCapabilities()}
              >
                {loadingCapabilities ? <span className="settings-action-spinner" /> : 'Refresh'}
              </button>
            </div>

            {capabilityError && <div className="settings-inline-error">{capabilityError}</div>}
            {capabilities && (
              <>
                <div className="capability-summary" aria-label="Codex capability summary">
                  <span><strong>{capabilities.skills.length}</strong> skills</span>
                  <span><strong>{capabilities.mcpServers.length}</strong> MCP servers</span>
                  <span><strong>{capabilities.appCount}</strong> apps</span>
                </div>

                <details className="capability-details">
                  <summary>Skills ({capabilities.skills.length})</summary>
                  <div className="settings-card capability-card">
                    {capabilities.skills.map((skill) => (
                      <div className="settings-row provider-row" key={skill.path}>
                        <div className="settings-copy">
                          <strong>${skill.name}</strong>
                          <span>{skill.description}</span>
                          {skill.pluginId && <span className="capability-source">{skill.pluginId}</span>}
                        </div>
                        <button
                          type="button"
                          role="switch"
                          className={`settings-switch${skill.enabled ? ' is-on' : ''}`}
                          aria-checked={skill.enabled}
                          disabled={changingCapability !== null}
                          onClick={() => void mutate(
                            `skill:${skill.path}`,
                            () => window.openyak.setCodexSkillEnabled(skill.path, !skill.enabled),
                          )}
                        >
                          <span className="settings-switch-knob" />
                        </button>
                      </div>
                    ))}
                  </div>
                </details>

                <details className="capability-details">
                  <summary>MCP servers ({capabilities.mcpServers.length})</summary>
                  <div className="settings-card capability-card">
                    {capabilities.mcpServers.map((server) => (
                      <div className="settings-row" key={server.name}>
                        <div className="settings-copy">
                          <strong>{server.name}</strong>
                          <span>{server.toolCount} tools{server.pluginId ? ` · ${server.pluginId}` : ''}</span>
                        </div>
                        <span className="provider-status">{server.status}</span>
                      </div>
                    ))}
                  </div>
                </details>

                {capabilities.errors.length > 0 && (
                  <div className="settings-inline-error">Some capability sources could not load: {capabilities.errors.join(' · ')}</div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
