import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import type {
  Agent,
  AgentConfigOption,
  AgentId,
  AgentStatus,
  Attachment,
  Project,
} from '../../shared/protocol'
import {
  draftsFromFiles,
  draftsFromPaths,
  mergeDrafts,
  toAttachment,
  type AttachmentDraft,
} from './attachmentDrafts'
import { Menu, useDismiss, type MenuEntry } from './Menu'
import { ModelPicker } from './ModelPicker'
import { ProjectPicker } from './ProjectPicker'
import {
  IconArrowUp,
  IconBulb,
  IconClose,
  IconFile,
  IconHand,
  IconMore,
  IconPaperclip,
  IconPlus,
  IconShield,
  IconStop,
  IconWarning,
} from './icons'

type SelectOption = Extract<AgentConfigOption, { type: 'select' }>

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
  /** A chat (task) exists to attach sessions to. */
  hasChat: boolean
  projects: Project[]
  draftProjectId: string | null
  onChooseProject: (id: string | null) => void
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
  cancelling: boolean
  onSend: (text: string, attachments: Attachment[], interrupt: boolean) => Promise<boolean>
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
  cancelling,
  onSend,
  onCancel,
}: Props) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const options = agent ? (optionsByAgent[agent] ?? null) : null
  const status = agent ? (statusByAgent[agent] ?? null) : null
  const set = (configId: string, value: string | boolean) => {
    if (agent) onSetConfig(agent, configId, value)
  }
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([])
  const [dragging, setDragging] = useState(false)
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const composerAreaRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useDismiss(composerAreaRef, addOpen, () => setAddOpen(false))

  const agentInfo = agents.find((a) => a.id === agent) ?? null
  const noAgent = !agents.some((a) => a.available)
  const needsChat = !hasChat
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const canSend = !noAgent && !submitting && !needsChat && hasContent

  const submit = () => {
    if (!canSend || submittingRef.current) return
    const draftText = text
    const draftAttachments = attachments
    submittingRef.current = true
    setSubmitting(true)
    setText('')
    setAttachments([])
    void onSend(draftText.trim(), draftAttachments.map(toAttachment), streaming)
      .then((sent) => {
        if (sent) return
        // A failed send should never eat the draft. Preserve anything typed meanwhile.
        setText((current) => current || draftText)
        setAttachments((current) => [...draftAttachments, ...current])
      })
      .finally(() => {
        submittingRef.current = false
        setSubmitting(false)
      })
  }

  const addFiles = (files: Iterable<File>) => {
    void draftsFromFiles(files).then(({ drafts, notices }) => {
      const merged = mergeDrafts(attachments, drafts)
      setAttachments(merged.drafts)
      const allNotices = [
        ...notices,
        ...merged.duplicateNames.map((name) => `${name} is already attached`),
      ]
      setAttachmentNotice(allNotices.length ? allNotices.join('. ') : null)
    })
  }
  const pickFiles = async () => {
    const paths = await window.openyak.pickFiles()
    if (paths.length === 0) return
    const merged = mergeDrafts(attachments, draftsFromPaths(paths))
    setAttachments(merged.drafts)
    const duplicateCount = merged.duplicateNames.length
    setAttachmentNotice(
      duplicateCount > 0
        ? `${duplicateCount} duplicate attachment${duplicateCount === 1 ? ' was' : 's were'} skipped`
        : null,
    )
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
    : 'Do anything'

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
      o.category !== 'collaboration_mode' &&
      !(o.category === 'model_config' && /fast/i.test(`${o.id} ${o.name}`)) &&
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
    <div
      className="composer-area"
      ref={composerAreaRef}
      onMouseDownCapture={(event) => {
        if (!addOpen) return
        const target = event.target as Element
        if (target.closest('.composer-add-panel, .composer-add-trigger')) return
        setAddOpen(false)
      }}
    >
      {draft && (
        <div className="composer-above">
          <ProjectPicker
            projects={projects}
            selectedId={draftProjectId}
            onChoose={onChooseProject}
            onAdd={onAddProject}
          />
        </div>
      )}

      {addOpen && (
        <div className="composer-add-panel" role="menu" aria-label="Add files">
          <div className="composer-add-heading">Add</div>
          <button
            type="button"
            className="composer-add-item"
            role="menuitem"
            onClick={() => {
              setAddOpen(false)
              void pickFiles()
            }}
          >
            <IconPaperclip size={17} />
            <span className="composer-add-label">Files and folders</span>
            <span className="composer-add-description">Or paste and drop them here</span>
          </button>
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
        {attachmentNotice && (
          <div className="attachment-notice" role="status">
            <IconWarning size={13} />
            <span>{attachmentNotice}</span>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => setAttachmentNotice(null)}
              aria-label="Dismiss attachment notice"
            >
              <IconClose size={12} />
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={noAgent}
          onFocus={() => setAddOpen(false)}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (streaming) {
                e.preventDefault()
                onCancel()
              }
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <div className="composer-row">
          <div className="composer-group">
            <button
              type="button"
              className={`plus composer-add-trigger${addOpen ? ' pill-open' : ''}`}
              disabled={noAgent}
              aria-label="Add files"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              title="Add files"
              onClick={() => setAddOpen((open) => !open)}
            >
              <IconPlus size={17} />
            </button>
            {modeOpt && (
              <Menu
                plain
                triggerClassName={`pill${modeKind === 'full_access' ? ' pill-warn' : ''}`}
                trigger={
                  <>
                    {modeIcon(modeKind)}
                    <span className="pill-label">{currentName(modeOpt)}</span>
                  </>
                }
                entries={selectEntries(modeOpt, true)}
                disabled={settingConfig === modeOpt.id || streaming || submitting}
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
              busy={settingConfig !== null || streaming || submitting}
              onAgentChange={onAgentChange}
              onSetConfig={onSetConfig}
            />
            {restEntries.length > 0 && (
              <Menu
                align="end"
                plain
                triggerClassName="composer-more"
                trigger={<IconMore size={16} />}
                entries={restEntries}
                disabled={settingConfig !== null || streaming || submitting}
                ariaLabel="More options"
                title="More options"
              />
            )}
            {streaming && !hasContent ? (
              <button
                type="button"
                className={`send stop${cancelling ? ' is-cancelling' : ''}`}
                onClick={onCancel}
                disabled={cancelling}
                title={cancelling ? 'Stopping…' : 'Stop response'}
                aria-label={cancelling ? 'Stopping response' : 'Stop response'}
              >
                <IconStop size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="send"
                disabled={!canSend}
                onClick={submit}
                title={
                  needsChat
                    ? 'Start a new chat first'
                    : streaming
                      ? 'Interrupt and send'
                      : 'Send message'
                }
                aria-label={streaming ? 'Interrupt and send message' : 'Send message'}
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
