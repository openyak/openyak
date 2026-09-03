import { Fragment, useRef, useState } from 'react'
import type { Agent, AgentConfigOption, AgentId, AgentStatus } from '../../shared/protocol'
import { useDismiss } from './Menu'
import { IconBolt, IconCheck, IconChevronDown, IconChevronRight } from './icons'

type SelectOption = Extract<AgentConfigOption, { type: 'select' }>
type BooleanOption = Extract<AgentConfigOption, { type: 'boolean' }>
type FastOption = SelectOption | BooleanOption

interface Props {
  agents: Agent[]
  /** Agent the next message goes to. */
  agent: AgentId | null
  /** Session options per agent for this chat; null while a session is starting. */
  optionsByAgent: Partial<Record<AgentId, AgentConfigOption[] | null>>
  statusByAgent: Partial<Record<AgentId, AgentStatus | null>>
  /** False until a project exists; sessions (and so models) need one. */
  hasChat: boolean
  busy: boolean
  onAgentChange: (id: AgentId) => void
  onSetConfig: (agent: AgentId, configId: string, value: string | boolean) => void
}

function findSelect(options: AgentConfigOption[] | null | undefined, category: string) {
  return options?.find((o): o is SelectOption => o.type === 'select' && o.category === category)
}

function isFastOption(option: AgentConfigOption): option is FastOption {
  return (
    (option.type === 'select' || option.type === 'boolean') &&
    option.category === 'model_config' &&
    /fast/i.test(`${option.id} ${option.name}`)
  )
}

/** Model names the way the vendors' own apps show them: "GPT-5.6-Sol" → "5.6 Sol". */
export function displayName(name: string): string {
  return name.startsWith('GPT-') ? name.slice(4).replace(/-/g, ' ') : name
}

const current = (o: SelectOption) => o.options.find((v) => v.value === o.current_value)
const currentName = (o: SelectOption) => displayName(current(o)?.name ?? o.current_value)

/** The vendor's "Default" entry keeps its blurb and gets a rule under it. */
const isDefaultChoice = (value: string, name: string) =>
  value === 'default' || /^default\b/i.test(name)

/**
 * One pill for "who answers and how hard they think". The card shows the current model
 * and an effort slider; the model list groups every installed agent's models, so picking
 * a model from another agent is how you switch agents.
 */
export function ModelPicker({
  agents,
  agent,
  optionsByAgent,
  statusByAgent,
  hasChat,
  busy,
  onAgentChange,
  onSetConfig,
}: Props) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'models'>('main')
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))

  const available = agents.filter((a) => a.available)
  if (available.length === 0 || !agent) return null

  const agentName = (id: AgentId) => agents.find((a) => a.id === id)?.name ?? id
  const options = optionsByAgent[agent] ?? null
  const model = findSelect(options, 'model')
  const effort = findSelect(options, 'thought_level')
  const fast = options?.find(isFastOption)
  const fastOn = fast?.type === 'select' ? fast.options.find((option) => option.value === 'on') : null
  const fastOff =
    fast?.type === 'select' ? fast.options.find((option) => option.value === 'off') : null
  const fastEnabled =
    fast?.type === 'boolean'
      ? fast.current_value
      : fast?.type === 'select' && fastOn
        ? fast.current_value === fastOn.value
        : false
  const canToggleFast =
    fast?.type === 'boolean' || (fast?.type === 'select' && !!fastOn && !!fastOff)
  const effortIndex = effort
    ? Math.max(
        0,
        effort.options.findIndex((v) => v.value === effort.current_value),
      )
    : 0

  const title = (
    <>
      <span>{model ? currentName(model) : agentName(agent)}</span>
      {effort && <span className="mp-accent">{currentName(effort)}</span>}
    </>
  )

  // Current agent first, then the others, each with its models.
  const ordered = [...available].sort((a, b) => (a.id === agent ? -1 : b.id === agent ? 1 : 0))

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        data-tooltip="Choose model and effort"
        className={`pill pill-model${open ? ' pill-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={busy}
        aria-label={`Model and effort: ${model ? currentName(model) : agentName(agent)}${effort ? `, ${currentName(effort)}` : ''}${fast ? `, fast mode ${fastEnabled ? 'on' : 'off'}` : ''}`}
        onClick={() => {
          setView('main')
          setOpen((o) => !o)
        }}
      >
        <IconBolt
          size={15}
          className={`pill-bolt${fastEnabled ? ' is-fast' : ''}`}
          aria-hidden="true"
        />
        <span className="pill-label">{title}</span>
        <IconChevronDown size={12} className="pill-chevron" />
      </button>

      {open && (
        <div className={`popover popover-top popover-end mp mp-${view}`} role="dialog">
          {view === 'main' ? (
            <>
              <div className={`mp-head${fast ? ' has-fast' : ''}`}>
                {fast && (
                  <span className="mp-fast-wrap">
                    <button
                      type="button"
                      data-tooltip-ignore="true"
                      className={`mp-fast${fastEnabled ? ' is-on' : ''}`}
                      disabled={busy || !canToggleFast}
                      aria-pressed={fastEnabled}
                      aria-label={fastEnabled ? 'Turn off fast mode' : 'Turn on fast mode'}
                      onClick={() => {
                        if (!canToggleFast) return
                        const value =
                          fast.type === 'boolean'
                            ? !fast.current_value
                            : fastEnabled
                              ? fastOff!.value
                              : fastOn!.value
                        onSetConfig(agent, fast.id, value)
                      }}
                    >
                      <IconBolt size={17} />
                    </button>
                    <span className="mp-fast-tooltip" role="tooltip">
                      <strong>{fast.name}</strong>
                      <span>{fast.description ?? 'Faster responses with higher usage'}</span>
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  className="mp-model-link"
                  onClick={() => setView('models')}
                  title="Change model or agent"
                >
                  <span className="mp-title">{title}</span>
                  <IconChevronRight size={15} className="mp-caret" />
                </button>
              </div>
              {effort && effort.options.length > 1 ? (
                <EffortSlider
                  count={effort.options.length}
                  index={effortIndex}
                  labels={effort.options.map((o) => o.description ?? o.name)}
                  onChange={(i) => onSetConfig(agent, effort.id, effort.options[i].value)}
                />
              ) : (
                <div className="mp-note">
                  {!hasChat
                    ? 'Add a project to start'
                    : statusByAgent[agent]?.state === 'exited'
                      ? `${agentName(agent)} is not available`
                      : options === null
                        ? `Starting ${agentName(agent)}…`
                        : null}
                </div>
              )}
            </>
          ) : (
            <div className="mp-model-list">
              {ordered.map((a) => {
                const opts = optionsByAgent[a.id]
                const m = findSelect(opts, 'model')
                const status = statusByAgent[a.id]
                const isCurrent = a.id === agent
                const pick = (value?: string) => {
                  setOpen(false)
                  if (!isCurrent) onAgentChange(a.id)
                  if (m && value !== undefined && value !== m.current_value)
                    onSetConfig(a.id, m.id, value)
                }
                return (
                  <div key={a.id} className="mp-agent">
                    <div className="mp-agent-name">{a.name}</div>
                    {m ? (
                      m.options.map((o) => {
                        const isDefault = isDefaultChoice(o.value, o.name)
                        return (
                          <Fragment key={o.value}>
                            <ModelItem
                              label={isDefault ? 'Default' : displayName(o.name)}
                              description={isDefault ? o.description : undefined}
                              title={o.description}
                              checked={isCurrent && o.value === m.current_value}
                              onSelect={() => pick(o.value)}
                            />
                            {isDefault && <div className="popover-separator" />}
                          </Fragment>
                        )
                      })
                    ) : opts ? (
                      <ModelItem label={a.name} checked={isCurrent} onSelect={() => pick()} />
                    ) : (
                      <ModelItem
                        label={a.name}
                        description={
                          !hasChat
                            ? 'Add a project to start'
                            : status?.state === 'exited'
                              ? 'Not available'
                              : 'Starting…'
                        }
                        checked={isCurrent}
                        disabled={!hasChat || status?.state === 'exited'}
                        onSelect={() => pick()}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ModelItem({
  label,
  description,
  title,
  checked,
  disabled,
  onSelect,
}: {
  label: string
  description?: string
  title?: string
  checked: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={`popover-item${checked ? ' checked' : ''}`}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      <span className="popover-item-body">
        <span className="popover-item-label">{label}</span>
        {description && <span className="popover-item-desc">{description}</span>}
      </span>
      {checked && <IconCheck size={15} className="popover-item-check" />}
    </button>
  )
}

// Deterministic particles keep the energy field alive without reflow or random flicker.
const SPARKS = [
  { x: 0.07, y: 0.68, size: 2, dx: 5, dy: -3, delay: -0.4, duration: 2.8 },
  { x: 0.14, y: 0.29, size: 3, dx: -3, dy: 4, delay: -1.9, duration: 3.5 },
  { x: 0.22, y: 0.52, size: 2, dx: 6, dy: 2, delay: -2.6, duration: 4.1 },
  { x: 0.31, y: 0.72, size: 2, dx: -5, dy: -4, delay: -1.1, duration: 3.1 },
  { x: 0.4, y: 0.34, size: 2, dx: 4, dy: 4, delay: -3.2, duration: 4.4 },
  { x: 0.49, y: 0.59, size: 3, dx: -4, dy: -3, delay: -0.8, duration: 3.7 },
  { x: 0.58, y: 0.25, size: 2, dx: 5, dy: 3, delay: -2.2, duration: 3.3 },
  { x: 0.66, y: 0.7, size: 2, dx: -6, dy: -2, delay: -1.5, duration: 4.2 },
  { x: 0.74, y: 0.42, size: 3, dx: 4, dy: -4, delay: -3.5, duration: 3.8 },
  { x: 0.82, y: 0.65, size: 2, dx: -3, dy: 3, delay: -0.2, duration: 3 },
  { x: 0.89, y: 0.28, size: 2, dx: 5, dy: 4, delay: -2.9, duration: 4.5 },
  { x: 0.95, y: 0.53, size: 3, dx: -4, dy: -3, delay: -1.7, duration: 3.4 },
]

function EffortSlider({
  count,
  index,
  labels,
  onChange,
}: {
  count: number
  index: number
  labels: string[]
  onChange: (index: number) => void
}) {
  const pct = count > 1 ? index / (count - 1) : 1
  return (
    <div
      className="slider"
      style={{ '--pct': `${pct * 100}%` } as React.CSSProperties}
      title={labels[index]}
    >
      <div className="slider-track">
        <div className="slider-ticks" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <span key={i} />
          ))}
        </div>
        <div className="slider-fill">
          {SPARKS.map((s, i) => (
            <span
              key={i}
              className="slider-spark"
              style={
                {
                  left: `${s.x * 100}%`,
                  top: `${s.y * 100}%`,
                  '--spark-size': `${s.size}px`,
                  '--spark-x': `${s.dx}px`,
                  '--spark-y': `${s.dy}px`,
                  animationDelay: `${s.delay}s`,
                  animationDuration: `${s.duration}s`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
        <div className="slider-thumb" />
      </div>
      <input
        type="range"
        min={0}
        max={count - 1}
        step={1}
        value={index}
        aria-label="Effort"
        aria-valuetext={labels[index]}
        onChange={(e) => {
          const i = Number(e.target.value)
          if (i !== index) onChange(i)
        }}
      />
    </div>
  )
}
