import { useState, type ClipboardEvent, type DragEvent } from 'react'
import type {
  Agent,
  AgentConfigOption,
  AgentId,
  AgentStatus,
  Attachment,
  Project,
} from '../../shared/protocol'
import { Menu, type MenuEntry } from './Menu'
import { ModelPicker } from './ModelPicker'
import {
  IconArrowUp,
  IconBulb,
  IconClose,
  IconFile,
  IconFolder,
  IconHand,
  IconMore,
  IconPaperclip,
  IconPlus,
  IconShield,
  IconStop,
  IconWarning,
} from './icons'

type SelectOption = Extract<AgentConfigOption, { type: 'select' }>

/** An attachment being composed: images are read into memory, files stay on disk. */
type Draft =
  | { id: string; type: 'image'; name: string; mime_type: string; data: string }
  | { id: string; type: 'file'; name: string; path: string }

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

let nextDraft = 1
const uid = () => String(nextDraft++)

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Images go inline so the agent can see them; everything else is a link to its path. */
async function draftsFromFiles(files: Iterable<File>): Promise<Draft[]> {
  const out: Draft[] = []
  for (const f of files) {
    const path = window.openyak.pathForFile(f)
    if (f.type.startsWith('image/') && f.size <= MAX_IMAGE_BYTES) {
      out.push({
        id: uid(),
        type: 'image',
        name: f.name || 'Image',
        mime_type: f.type,
        data: await readBase64(f),
      })
    } else if (path) {
      out.push({ id: uid(), type: 'file', name: basename(path), path })
    }
  }
  return out
}

function toAttachment(d: Draft): Attachment {
  return d.type === 'image'
    ? { type: 'image', mime_type: d.mime_type, data: d.data }
    : { type: 'file', path: d.path }
}

/** Icon for a permission mode, from the kind the agent tags it with. */
function modeIcon(kind: string | undefined, size = 15) {
  switch (kind) {
    case 'full_access':
      return <IconWarning size={size} />
    case 'plan':
      return <IconBulb size={size} />
    case 'auto_review':
      return <IconShield size={size} />
    default:
      return <IconHand size={size} />
  }
}

interface Props {
  /** The chat has no messages yet: the project can still be changed. */
  draft: boolean
  /** A chat (task) exists to attach sessions to; false only with no projects. */
  hasChat: boolean
  projects: Project[]
  draftProjectId: string | null
  onChooseProject: (id: string) => void
  onAddProject: () => void
  agents: Agent[]
  agent: AgentId | null
  onAgentChange: (id: AgentId) => void
  /** Session options per agent for this task; null until that session reports them. */
  optionsByAgent: Partial<Record<AgentId, AgentConfigOption[] | null>>
  statusByAgent: Partial<Record<AgentId, AgentStatus | null>>
  settingConfig: string | null
  onSetConfig: (agent: AgentId, configId: string, value: string | boolean) => void
  streaming: boolean
  onSend: (text: string, attachments: Attachment[]) => void
  onCancel: () => void
}

export function Composer({
  draft,
  hasChat,
  projects,
  draftProjectId,
  onChooseProject,
  onAddProject,
  agents,
  agent,
  onAgentChange,
  optionsByAgent,
  statusByAgent,
  settingConfig,
  onSetConfig,
  streaming,
  onSend,
  onCancel,
}: Props) {
  const [text, setText] = useState('')
  const options = agent ? (optionsByAgent[agent] ?? null) : null
  const status = agent ? (statusByAgent[agent] ?? null) : null
  const set = (configId: string, value: string | boolean) => {
    if (agent) onSetConfig(agent, configId, value)
  }
  const [attachments, setAttachments] = useState<Draft[]>([])
  const [dragging, setDragging] = useState(false)

  const agentInfo = agents.find((a) => a.id === agent) ?? null
  const noAgent = !agents.some((a) => a.available)
  const needsProject = !hasChat
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const canSend = !noAgent && !streaming && !needsProject && hasContent

  const submit = () => {
    if (!canSend) return
    onSend(text.trim(), attachments.map(toAttachment))
    setText('')
    setAttachments([])
  }

  const addFiles = (files: Iterable<File>) => {
    void draftsFromFiles(files).then((d) => {
      if (d.length) setAttachments((prev) => [...prev, ...d])
    })
  }
  const pickFiles = async () => {
    const paths = await window.openyak.pickFiles()
    if (paths.length === 0) return
    setAttachments((prev) => [
      ...prev,
      ...paths.map((path): Draft => ({ id: uid(), type: 'file', name: basename(path), path })),
    ])
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files]
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const placeholder = noAgent
    ? 'Install and log in to Claude Code or Codex to start'
    : agentInfo
      ? `Work with ${agentInfo.name}`
      : 'Ask anything'

  // Project picker (new chat only).
  const project = projects.find((p) => p.id === draftProjectId) ?? null
  const projectEntries: MenuEntry[] = [
    ...projects.map((p) => ({
      id: p.id,
      label: p.name,
      description: p.path,
      checked: p.id === draftProjectId,
      onSelect: () => onChooseProject(p.id),
    })),
    ...(projects.length > 0 ? [{ separator: true } as const] : []),
    { id: '__add', label: 'Add project…', icon: <IconPlus size={14} />, onSelect: onAddProject },
  ]

  const addEntries: MenuEntry[] = [
    { section: 'Add' },
    {
      id: 'files',
      label: 'Files and folders',
      description: 'Or paste and drop them here',
      icon: <IconPaperclip size={15} />,
      onSelect: () => void pickFiles(),
    },
  ]

  // The agent's options, placed by category: mode on the left; model and effort (and the
  // agent itself) share one picker on the right; anything else sits behind "more".
  // Values go back to the agent untouched.
  const select = (category: string): SelectOption | undefined =>
    options?.find((o): o is SelectOption => o.type === 'select' && o.category === category)
  const modeOpt = select('mode')
  const rest = (options ?? []).filter(
    (o) =>
      o !== modeOpt &&
      o.category !== 'model' &&
      o.category !== 'thought_level' &&
      o.type !== 'unknown',
  )

  const current = (o: SelectOption) => o.options.find((v) => v.value === o.current_value)
  const currentName = (o: SelectOption) => current(o)?.name ?? o.current_value

  const selectEntries = (o: SelectOption, icons = false): MenuEntry[] => {
    const entries: MenuEntry[] = []
    let group: string | undefined
    for (const v of o.options) {
      if (v.group !== undefined && v.group !== group) {
        group = v.group
        entries.push({ section: group })
      }
      entries.push({
        id: v.value,
        label: v.name,
        description: v.description,
        icon: icons ? modeIcon(v.kind, 15) : undefined,
        checked: v.value === o.current_value,
        onSelect: () => set(o.id, v.value),
      })
    }
    return entries
  }

  const restEntries: MenuEntry[] = rest.flatMap((o): MenuEntry[] => {
    if (o.type === 'select') return [{ section: o.name }, ...selectEntries(o)]
    if (o.type === 'boolean')
      return [
        { section: o.name },
        { id: `${o.id}:on`, label: 'On', checked: o.current_value, onSelect: () => set(o.id, true) },
        { id: `${o.id}:off`, label: 'Off', checked: !o.current_value, onSelect: () => set(o.id, false) },
      ]
    return []
  })

  const hint =
    !draft && agentInfo && options === null
      ? status?.state === 'exited'
        ? `${agentInfo.name} exited${status.detail ? `: ${status.detail}` : ''}`
        : `Starting ${agentInfo.name}…`
      : null

  const modeKind = modeOpt ? current(modeOpt)?.kind : undefined

  return (
    <div className="composer-area">
      {draft && (
        <div className="composer-above">
          <Menu
            className="chip"
            trigger={
              <>
                <IconFolder size={15} />
                <span className="pill-label">{project ? project.name : 'Choose project'}</span>
              </>
            }
            entries={projectEntries}
            title={project?.path ?? 'The folder your agents will work in'}
          />
        </div>
      )}

      <div
        className={`composer${noAgent ? ' composer-disabled' : ''}${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragging) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a) => (
              <div
                key={a.id}
                className={`attach attach-${a.type}`}
                title={a.type === 'file' ? a.path : a.name}
              >
                {a.type === 'image' ? (
                  <img src={`data:${a.mime_type};base64,${a.data}`} alt={a.name} />
                ) : (
                  <>
                    <IconFile size={14} />
                    <span className="attach-name">{a.name}</span>
                  </>
                )}
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={noAgent}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <div className="composer-row">
          <div className="composer-group">
            <Menu
              plain
              inlineDesc
              className="menu-add"
              triggerClassName="plus"
              trigger={<IconPlus size={17} />}
              entries={addEntries}
              disabled={noAgent}
              ariaLabel="Add files and more"
              title="Add files and more"
            />
            {modeOpt && (
              <Menu
                triggerClassName={`pill${modeKind === 'full_access' ? ' pill-warn' : ''}`}
                trigger={
                  <>
                    {modeIcon(modeKind)}
                    <span className="pill-label">{currentName(modeOpt)}</span>
                  </>
                }
                entries={selectEntries(modeOpt, true)}
                disabled={settingConfig === modeOpt.id}
                title={current(modeOpt)?.description ?? modeOpt.description ?? modeOpt.name}
              />
            )}
            {hint && (
              <span className={`composer-hint${status?.state === 'exited' ? ' is-error' : ''}`}>
                {hint}
              </span>
            )}
          </div>
          <div className="composer-group">
            <ModelPicker
              agents={agents}
              agent={agent}
              optionsByAgent={optionsByAgent}
              statusByAgent={statusByAgent}
              hasChat={hasChat}
              busy={settingConfig !== null}
              onAgentChange={onAgentChange}
              onSetConfig={onSetConfig}
            />
            {restEntries.length > 0 && (
              <Menu
                align="end"
                plain
                trigger={<IconMore size={16} />}
                entries={restEntries}
                disabled={settingConfig !== null}
                ariaLabel="More options"
                title="More options"
              />
            )}
            {streaming ? (
              <button
                type="button"
                className="send stop"
                onClick={onCancel}
                title="Stop"
                aria-label="Stop"
              >
                <IconStop size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="send"
                disabled={!canSend}
                onClick={submit}
                title={needsProject ? 'Choose a project first' : 'Send'}
                aria-label="Send"
              >
                <IconArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
