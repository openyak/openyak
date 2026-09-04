import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Agent,
  AgentConfig,
  AgentConfigOption,
  AgentId,
  AgentStatus,
  Attachment,
  ChatDone,
  ChatUpdate,
  Message,
  PermissionRequest,
  PermissionResponse,
  Project,
  Task,
  ThemePreference,
} from '../../shared/protocol'
import { request } from './api'
import { Sidebar } from './Sidebar'
import { Thread } from './Thread'
import { Composer } from './Composer'
import { IconClose, IconSidebarToggle } from './icons'
import { titleFrom } from './format'
import { ButtonTooltip } from './ButtonTooltip'
import { Settings } from './Settings'
import { readThemePreference, THEME_KEY } from './theme'

export interface PendingPermission {
  request: PermissionRequest
  resolve: (res: PermissionResponse | null) => void
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Key for state kept per (task, agent) pair: agent status and session options. */
function pairKey(taskId: string, agent: AgentId): string {
  return `${taskId}/${agent}`
}

/** A chat that has not started. It exists so the agents' sessions and options do. */
const isDraft = (t: Task | null | undefined): boolean => !!t && t.message_count === 0

const NO_TASK = '__none'
const PROJECTLESS_TASKS = '__projectless'
const SIDEBAR_KEY = 'openyak.sidebar'
const PROVIDERS_ENABLED_KEY = 'openyak.providers.enabled'
const DEFAULT_PROVIDER_KEY = 'openyak.providers.default'
const PROVIDER_SETUP_URLS: Record<AgentId, string> = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code',
  codex: 'https://github.com/openai/codex',
}
const isMac = navigator.platform.startsWith('Mac')

function readEnabledProviders(): Record<AgentId, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(PROVIDERS_ENABLED_KEY) ?? '{}') as Partial<
      Record<AgentId, boolean>
    >
    return { claude: value.claude !== false, codex: value.codex !== false }
  } catch {
    return { claude: true, codex: true }
  }
}

function readDefaultProvider(): AgentId {
  try {
    return localStorage.getItem(DEFAULT_PROVIDER_KEY) === 'codex' ? 'codex' : 'claude'
  } catch {
    return 'claude'
  }
}

/** Remove Electron/RPC implementation details before an error reaches the UI. */
function userErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const message = raw
    .replace(/^Error:\s*/, '')
    .replace(/^Error invoking remote method 'core:request': Error:\s*/, '')
    .replace(/\s*\(code -?\d+\)\s*$/, '')
  if (/auto mode disabled by settings/i.test(message)) {
    return 'Auto mode is disabled in Claude Code settings.'
  }
  return message
}

function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed'
  } catch {
    return true
  }
}

function taskBucket(projectId: string | null): string {
  return projectId ?? PROJECTLESS_TASKS
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [enabledProviders, setEnabledProviders] =
    useState<Record<AgentId, boolean>>(readEnabledProviders)
  const [defaultProvider, setDefaultProvider] = useState<AgentId>(readDefaultProvider)
  const [activeView, setActiveView] = useState<'chat' | 'settings'>('chat')
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference)
  const [scanningProviders, setScanningProviders] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({})
  const [taskId, setTaskId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  // Agent explicitly picked per task; else the task's last-used agent.
  const [agentChoice, setAgentChoice] = useState<Record<string, AgentId>>({})
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [configs, setConfigs] = useState<Record<string, AgentConfigOption[]>>({})
  const [settingConfig, setSettingConfig] = useState<string | null>(null)
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [editingMessage, setEditingMessage] = useState<Message | null>(null)
  const [workingTasks, setWorkingTasks] = useState<Set<string>>(() => new Set())
  const [coreExited, setCoreExited] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebar)

  // Latest values, readable from handlers and callbacks without re-creating them.
  const taskRef = useRef<string | null>(null)
  const agentRef = useRef<AgentId | null>(null)
  const optimisticSequence = useRef(0)
  const bootstrapped = useRef(false)
  const tasksRef = useRef<Record<string, Task[]>>({})
  const projectsRef = useRef<Project[]>([])
  useEffect(() => {
    taskRef.current = taskId
  }, [taskId])
  useEffect(() => {
    tasksRef.current = tasksByProject
  }, [tasksByProject])
  useEffect(() => {
    projectsRef.current = projects
  }, [projects])

  const fail = useCallback((err: unknown) => setError(userErrorMessage(err)), [])

  useEffect(() => {
    void window.openyak.setTheme(theme).catch(fail)
  }, [fail, theme])

  const updateTheme = useCallback((value: ThemePreference) => {
    setTheme(value)
    try {
      localStorage.setItem(THEME_KEY, value)
    } catch {
      // The preference still applies for this app session.
    }
  }, [])

  const updateProviderEnabled = useCallback((id: AgentId, enabled: boolean) => {
    setEnabledProviders((current) => {
      const next = { ...current, [id]: enabled }
      try {
        localStorage.setItem(PROVIDERS_ENABLED_KEY, JSON.stringify(next))
      } catch {
        // The preference still applies for this app session.
      }
      return next
    })
    if (!enabled && defaultProvider === id) {
      const fallback = agents.find(
        (candidate) => candidate.id !== id && candidate.available && enabledProviders[candidate.id],
      )
      if (fallback) {
        setDefaultProvider(fallback.id)
        try {
          localStorage.setItem(DEFAULT_PROVIDER_KEY, fallback.id)
        } catch {
          // The preference still applies for this app session.
        }
      }
    }
    if (!enabled) {
      void request('agent.disconnect', { agent: id }).catch(fail)
      setStatuses((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.endsWith(`/${id}`)),
        ),
      )
      setConfigs((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.endsWith(`/${id}`)),
        ),
      )
    }
  }, [agents, defaultProvider, enabledProviders, fail])

  const updateDefaultProvider = useCallback((id: AgentId) => {
    setDefaultProvider(id)
    try {
      localStorage.setItem(DEFAULT_PROVIDER_KEY, id)
    } catch {
      // The preference still applies for this app session.
    }
  }, [])

  const rescanProviders = useCallback(async () => {
    const startedAt = performance.now()
    setScanningProviders(true)
    setError(null)
    try {
      setAgents(await request<Agent[]>('agent.list'))
    } catch (err) {
      fail(err)
    } finally {
      // Keep fast local scans visible long enough to register as feedback.
      const remaining = 450 - (performance.now() - startedAt)
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
      setScanningProviders(false)
    }
  }, [fail])

  const openProviderSetup = useCallback(
    (id: AgentId) => {
      void window.openyak.openExternal(PROVIDER_SETUP_URLS[id]).catch(fail)
    },
    [fail],
  )

  const markTaskWorking = useCallback((id: string, working: boolean) => {
    setWorkingTasks((current) => {
      if (current.has(id) === working) return current
      const next = new Set(current)
      if (working) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const loadTasks = useCallback(async (projectId: string | null): Promise<Task[]> => {
    const t = await request<Task[]>('task.list', { project_id: projectId })
    setTasksByProject((prev) => ({ ...prev, [taskBucket(projectId)]: t }))
    return t
  }, [])

  /**
   * Open the chat a new message in `projectId` will start in, creating a draft task if
   * the project has none. Its sessions come up right away, so the picker shows real
   * models and effort levels before anything is sent.
   */
  const openDraft = useCallback(async (projectId: string | null, known?: Task[]) => {
    const bucket = taskBucket(projectId)
    const list = known ?? tasksRef.current[bucket] ?? []
    let task = list.find((t) => t.message_count === 0) ?? null
    if (!task) {
      const created = await request<Task>('task.create', {
        project_id: projectId,
        title: 'New chat',
      })
      task = created
      setTasksByProject((prev) => ({
        ...prev,
        [bucket]: [created, ...(prev[bucket] ?? [])],
      }))
    }
    taskRef.current = task.id
    setTaskId(task.id)
    setMessages([])
  }, [])

  /** Leaving an unsent new chat deletes it; core also purges leftovers on startup. */
  const dropIfDraft = useCallback((id: string | null) => {
    const task = Object.values(tasksRef.current)
      .flat()
      .find((t) => t.id === id)
    if (!task || !isDraft(task)) return
    const bucket = taskBucket(task.project_id)
    setTasksByProject((prev) => ({
      ...prev,
      [bucket]: (prev[bucket] ?? []).filter((t) => t.id !== task.id),
    }))
    request('task.delete', { task_id: task.id }).catch(() => {})
  }, [])

  // Initial load: agents, projects, every project's tasks, then a new chat to start in.
  useEffect(() => {
    // React Strict Mode intentionally replays effects in development. Creating a draft
    // is not idempotent, so guard the one-time boot sequence explicitly.
    if (bootstrapped.current) return
    bootstrapped.current = true
    request<Agent[]>('agent.list').then(setAgents).catch(fail)
    request<Project[]>('project.list')
      .then(async (ps) => {
        setProjects(ps)
        const [projectless] = await Promise.all([
          loadTasks(null),
          ...ps.map((p) => loadTasks(p.id)),
        ])
        await openDraft(null, projectless)
      })
      .catch(fail)
  }, [fail, loadTasks, openDraft])

  // Load history when a chat with messages is selected.
  useEffect(() => {
    if (!taskId) return
    const task = Object.values(tasksRef.current)
      .flat()
      .find((t) => t.id === taskId)
    if (isDraft(task)) return
    let live = true
    request<Message[]>('chat.history', { task_id: taskId })
      .then((m) => {
        if (live) setMessages(m)
      })
      .catch(fail)
    return () => {
      live = false
    }
  }, [taskId, fail])

  /** Move a task to the top of its project after activity, counting new messages. */
  const bumpTask = useCallback((id: string, added = 0) => {
    const now = new Date().toISOString()
    setTasksByProject((prev) => {
      const next = { ...prev }
      for (const pid of Object.keys(next)) {
        if (!next[pid].some((t) => t.id === id)) continue
        next[pid] = next[pid]
          .map((t) =>
            t.id === id ? { ...t, updated_at: now, message_count: t.message_count + added } : t,
          )
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      }
      return next
    })
  }, [])

  /** Replays can shorten a transcript, so update its count rather than applying a delta. */
  const setTaskActivity = useCallback((id: string, messageCount: number, title?: string) => {
    const now = new Date().toISOString()
    setTasksByProject((prev) => {
      const next = { ...prev }
      for (const pid of Object.keys(next)) {
        if (!next[pid].some((t) => t.id === id)) continue
        next[pid] = next[pid]
          .map((t) =>
            t.id === id
              ? {
                  ...t,
                  title: title ?? t.title,
                  updated_at: now,
                  message_count: messageCount,
                }
              : t,
          )
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      }
      return next
    })
  }, [])

  // Core notifications, permission requests, and exit.
  useEffect(() => {
    const offNotification = window.openyak.onNotification((n) => {
      if (import.meta.env.DEV) console.log(`[rpc ⇠] ${n.method}`, JSON.stringify(n.params))
      switch (n.method) {
        case 'chat.update': {
          const u = n.params as ChatUpdate
          markTaskWorking(u.task_id, true)
          if (u.task_id !== taskRef.current) return
          setMessages((prev) => applyUpdate(prev, u, agentRef.current))
          return
        }
        case 'chat.done': {
          const d = n.params as ChatDone
          markTaskWorking(d.task_id, false)
          bumpTask(d.task_id)
          if (d.task_id !== taskRef.current) return
          setCancelling(false)
          setMessages((prev) => applyDone(prev, d, agentRef.current))
          return
        }
        case 'agent.status': {
          const s = n.params as AgentStatus
          setStatuses((prev) => ({ ...prev, [pairKey(s.task_id, s.agent)]: s }))
          if (s.state === 'exited') {
            // Options belong to the session that just went away.
            setConfigs((prev) => {
              const next = { ...prev }
              delete next[pairKey(s.task_id, s.agent)]
              return next
            })
          }
          return
        }
        case 'agent.config': {
          const c = n.params as AgentConfig
          setConfigs((prev) => ({ ...prev, [pairKey(c.task_id, c.agent)]: c.options }))
          return
        }
      }
    })
    const offPermission = window.openyak.onPermissionRequest(
      (req) =>
        new Promise<PermissionResponse | null>((resolve) => {
          if (import.meta.env.DEV) console.log('[rpc ⇠] permission.request', JSON.stringify(req))
          setPermission({ request: req, resolve })
        }),
    )
    const offExit = window.openyak.onCoreExited((exit) => {
      setWorkingTasks(new Set())
      setCoreExited(
        `Core exited (code ${exit.code ?? '-'}, signal ${exit.signal ?? '-'}). Restart OpenYak.`,
      )
    })
    return () => {
      offNotification()
      offPermission()
      offExit()
    }
  }, [bumpTask, markTaskWorking])

  // Disabled providers remain visible in Settings but are neither started nor offered in
  // the composer. The next message uses an explicit choice, then chat history, then the
  // user's default provider, and finally the first enabled installation.
  const composerAgents = agents.map((candidate) => ({
    ...candidate,
    available: candidate.available && enabledProviders[candidate.id],
  }))
  const available = composerAgents.filter((candidate) => candidate.available)
  const isAvailable = (id: AgentId | null | undefined): id is AgentId =>
    !!id && available.some((a) => a.id === id)
  const chosen = agentChoice[taskId ?? NO_TASK]
  const lastUsed = [...messages].reverse().find((m) => isAvailable(m.agent))?.agent
  const agent: AgentId | null = isAvailable(chosen)
    ? chosen
    : isAvailable(lastUsed)
      ? lastUsed
      : isAvailable(defaultProvider)
        ? defaultProvider
        : (available[0]?.id ?? null)

  useEffect(() => {
    agentRef.current = agent
  }, [agent])

  // Bring every installed agent's session up for the selected chat, so their models are
  // all listed in the picker and switching costs nothing.
  const availableIds = available.map((a) => a.id).join(',')
  useEffect(() => {
    if (!taskId || !availableIds) return
    for (const id of availableIds.split(',')) {
      request('agent.connect', { task_id: taskId, agent: id }).catch(fail)
    }
  }, [taskId, availableIds, fail])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, o ? 'closed' : 'open')
      } catch {
        // Per-viewer convenience only.
      }
      return !o
    })
  }, [])

  const currentTask = useCallback(
    () =>
      Object.values(tasksRef.current)
        .flat()
        .find((t) => t.id === taskRef.current) ?? null,
    [],
  )

  const newChat = useCallback(() => {
    setActiveView('chat')
    const current = currentTask()
    if (isDraft(current) && current?.project_id === null) return
    dropIfDraft(taskRef.current)
    setEditingMessage(null)
    void openDraft(null).catch(fail)
  }, [currentTask, dropIfDraft, openDraft, fail])

  const selectTask = useCallback(
    (id: string) => {
      setActiveView('chat')
      if (id === taskRef.current) return
      dropIfDraft(taskRef.current)
      setCancelling(false)
      setEditingMessage(null)
      setTaskId(id)
      setMessages([])
    },
    [dropIfDraft],
  )

  const selectProject = useCallback(
    (pid: string | null) => {
      setActiveView('chat')
      const current = currentTask()
      if (current && isDraft(current) && current.project_id === pid) return
      dropIfDraft(taskRef.current)
      setCancelling(false)
      setEditingMessage(null)
      void openDraft(pid).catch(fail)
    },
    [currentTask, dropIfDraft, openDraft, fail],
  )

  const addProject = useCallback(async () => {
    setActiveView('chat')
    const dir = await window.openyak.pickDirectory()
    if (!dir) return
    try {
      const p = await request<Project>('project.create', { name: basename(dir), path: dir })
      setProjects((prev) => [...prev, p])
      setTasksByProject((prev) => ({ ...prev, [p.id]: [] }))
      dropIfDraft(taskRef.current)
      await openDraft(p.id, [])
    } catch (err) {
      fail(err)
    }
  }, [dropIfDraft, openDraft, fail])

  const updateProject = useCallback(
    async (id: string, name: string, path: string) => {
      try {
        setError(null)
        const updated = await request<Project>('project.update', { project_id: id, name, path })
        setProjects((prev) => prev.map((project) => (project.id === id ? updated : project)))
      } catch (err) {
        fail(err)
        throw err
      }
    },
    [fail],
  )

  const renameTask = useCallback(
    async (id: string, title: string) => {
      try {
        setError(null)
        const renamed = await request<Task>('task.rename', { task_id: id, title })
        const bucket = taskBucket(renamed.project_id)
        setTasksByProject((prev) => ({
          ...prev,
          [bucket]: (prev[bucket] ?? []).map((task) =>
            task.id === id ? renamed : task,
          ),
        }))
      } catch (err) {
        fail(err)
        throw err
      }
    },
    [fail],
  )

  const deleteProject = useCallback(
    async (id: string) => {
      const deletedTasks = tasksRef.current[id] ?? []
      const deletedIds = new Set(deletedTasks.map((task) => task.id))
      const selectedWillClose = !!taskRef.current && deletedIds.has(taskRef.current)
      try {
        setError(null)
        await request('project.delete', { project_id: id })

        const remainingProjects = projectsRef.current.filter((project) => project.id !== id)
        const nextTasks = { ...tasksRef.current }
        delete nextTasks[id]
        projectsRef.current = remainingProjects
        tasksRef.current = nextTasks
        setProjects(remainingProjects)
        setTasksByProject(nextTasks)
        setStatuses((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(([key]) => ![...deletedIds].some((taskId) => key.startsWith(`${taskId}/`))),
          ),
        )
        setConfigs((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(([key]) => ![...deletedIds].some((taskId) => key.startsWith(`${taskId}/`))),
          ),
        )
        setAgentChoice((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([key]) => !deletedIds.has(key))),
        )
        setWorkingTasks((prev) => {
          const next = new Set(prev)
          for (const taskId of deletedIds) next.delete(taskId)
          return next
        })

        if (permission && deletedIds.has(permission.request.task_id)) {
          permission.resolve(null)
          setPermission(null)
        }
        if (!selectedWillClose) return
        taskRef.current = null
        setTaskId(null)
        setMessages([])
        setEditingMessage(null)
        setCancelling(false)
        await openDraft(null, nextTasks[PROJECTLESS_TASKS] ?? [])
      } catch (err) {
        fail(err)
        throw err
      }
    },
    [fail, openDraft, permission],
  )

  const deleteTask = useCallback(
    async (id: string) => {
      const task = Object.values(tasksRef.current)
        .flat()
        .find((candidate) => candidate.id === id)
      if (!task) return
      const bucket = taskBucket(task.project_id)
      const selectedWillClose = taskRef.current === id
      try {
        setError(null)
        await request('task.delete', { task_id: id })
        const remaining = (tasksRef.current[bucket] ?? []).filter(
          (candidate) => candidate.id !== id,
        )
        const nextTasks = { ...tasksRef.current, [bucket]: remaining }
        tasksRef.current = nextTasks
        setTasksByProject(nextTasks)
        setStatuses((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${id}/`))),
        )
        setConfigs((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${id}/`))),
        )
        setAgentChoice((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        markTaskWorking(id, false)
        if (permission?.request.task_id === id) {
          permission.resolve(null)
          setPermission(null)
        }
        if (!selectedWillClose) return
        taskRef.current = null
        setTaskId(null)
        setMessages([])
        setEditingMessage(null)
        setCancelling(false)
        await openDraft(task.project_id, remaining)
      } catch (err) {
        fail(err)
        throw err
      }
    },
    [fail, markTaskWorking, openDraft, permission],
  )

  const chooseAgent = useCallback(
    (id: AgentId) => setAgentChoice((prev) => ({ ...prev, [taskId ?? NO_TASK]: id })),
    [taskId],
  )

  // Not memoized: the React Compiler lint cannot prove `agent` stable across the
  // attachment handling below, and nothing downstream is memoized anyway.
  const send = async (
    text: string,
    attachments: Attachment[],
    interrupt = false,
  ): Promise<boolean> => {
    const id = taskRef.current
    if (!agent || !id) return false
    const originalTask = currentTask()
    const firstMessage = isDraft(originalTask)
    const firstFile = attachments.find((a) => a.type === 'file')
    const optimisticTitle = text.trim()
      ? titleFrom(text)
      : firstFile
        ? basename(firstFile.path)
        : 'Image'
    const optimisticKey = ++optimisticSequence.current
    const temporaryUserId = `optimistic-user-${optimisticKey}`
    const temporaryAssistantId = `optimistic-assistant-${optimisticKey}`
    const now = new Date().toISOString()
    const parts = partsFrom(text, attachments)

    // Echo the message immediately. Besides feeling faster, this closes the tiny window
    // where a second Enter could start a concurrent run before chat.send returns.
    setError(null)
    setCancelling(false)
    markTaskWorking(id, true)
    setMessages((prev) => [
      ...prev,
      {
        id: temporaryUserId,
        task_id: id,
        role: 'user',
        agent,
        parts,
        created_at: now,
        status: 'done',
      },
      {
        id: temporaryAssistantId,
        task_id: id,
        role: 'assistant',
        agent,
        parts: [],
        created_at: now,
        status: 'streaming',
      },
    ])
    if (firstMessage && originalTask) {
      const bucket = taskBucket(originalTask.project_id)
      setTasksByProject((prev) => ({
        ...prev,
        [bucket]: (prev[bucket] ?? []).map((t) =>
          t.id === id ? { ...t, title: optimisticTitle } : t,
        ),
      }))
    }
    bumpTask(id, 2)

    try {
      const r = await request<{ user_message_id: string; assistant_message_id: string }>(
        'chat.send',
        attachments.length ? { task_id: id, agent, text, attachments } : { task_id: id, agent, text },
      )
      setMessages((prev) =>
        reconcileSentMessages(
          prev,
          temporaryUserId,
          temporaryAssistantId,
          r.user_message_id,
          r.assistant_message_id,
          agent,
        ),
      )
      if (interrupt) {
        // Queue the correction first, then interrupt the active turn. The agent connection
        // keeps the new Job queued and starts it as soon as cancellation settles.
        if (permission) {
          permission.resolve(null)
          setPermission(null)
        }
        void request('chat.cancel', { task_id: id }).catch(fail)
      }
      if (firstMessage) {
        void request<Task>('task.rename', { task_id: id, title: optimisticTitle })
          .then((renamed) => {
            const bucket = taskBucket(renamed.project_id)
            setTasksByProject((prev) => ({
              ...prev,
              [bucket]: (prev[bucket] ?? []).map((t) =>
                t.id === id ? { ...t, title: renamed.title } : t,
              ),
            }))
          })
          .catch(fail)
      }
      return true
    } catch (err) {
      setMessages((prev) =>
        prev.filter((m) => m.id !== temporaryUserId && m.id !== temporaryAssistantId),
      )
      if (originalTask) {
        const bucket = taskBucket(originalTask.project_id)
        setTasksByProject((prev) => ({
          ...prev,
          [bucket]: (prev[bucket] ?? []).map((t) =>
            t.id === id ? originalTask : t,
          ),
        }))
      }
      markTaskWorking(id, false)
      fail(err)
      return false
    }
  }

  const reconnectOtherAgents = (id: string, active: AgentId) => {
    for (const candidate of available) {
      if (candidate.id === active) continue
      void request('agent.connect', { task_id: id, agent: candidate.id }).catch(fail)
    }
  }

  /** Replace a user turn and replay from there. Later transcript turns are intentionally
   * replaced; working-tree edits are not rolled back. */
  const editAndResend = async (
    source: Message,
    text: string,
    attachments: Attachment[],
  ): Promise<boolean> => {
    const id = taskRef.current
    if (!agent || !id || source.task_id !== id) return false
    const index = messages.findIndex((message) => message.id === source.id)
    if (index < 0 || source.role !== 'user' || messages.some((m) => m.status === 'streaming')) {
      return false
    }
    const originalMessages = messages
    const originalTask = currentTask()
    const prefix = messages.slice(0, index)
    const optimisticKey = ++optimisticSequence.current
    // Keep the edited row mounted while the request is in flight so a failed RPC can
    // restore the exact draft (including attachment changes) instead of resetting it.
    const temporaryUserId = source.id
    const temporaryAssistantId = `optimistic-edit-assistant-${optimisticKey}`
    const now = new Date().toISOString()
    const parts = partsFrom(text, attachments)
    const nextMessages: Message[] = [
      ...prefix,
      {
        id: temporaryUserId,
        task_id: id,
        role: 'user',
        agent,
        parts,
        created_at: now,
        status: 'done',
      },
      {
        id: temporaryAssistantId,
        task_id: id,
        role: 'assistant',
        agent,
        parts: [],
        created_at: now,
        status: 'streaming',
      },
    ]
    const firstTurn = prefix.length === 0
    const firstFile = attachments.find((attachment) => attachment.type === 'file')
    const nextTitle = firstTurn
      ? text.trim()
        ? titleFrom(text)
        : firstFile
          ? basename(firstFile.path)
          : 'Image'
      : undefined

    setError(null)
    markTaskWorking(id, true)
    setMessages(nextMessages)
    setTaskActivity(id, nextMessages.length, nextTitle)
    try {
      const result = await request<{ user_message_id: string; assistant_message_id: string }>(
        'chat.edit',
        { task_id: id, message_id: source.id, agent, text, attachments },
      )
      setMessages((prev) =>
        reconcileSentMessages(
          prev,
          temporaryUserId,
          temporaryAssistantId,
          result.user_message_id,
          result.assistant_message_id,
          agent,
        ),
      )
      setEditingMessage(null)
      reconnectOtherAgents(id, agent)
      if (nextTitle) {
        void request<Task>('task.rename', { task_id: id, title: nextTitle }).catch(fail)
      }
      return true
    } catch (err) {
      markTaskWorking(id, false)
      setMessages(originalMessages)
      setTaskActivity(id, originalMessages.length, originalTask?.title)
      fail(err)
      return false
    }
  }

  const retry = async (source: Message): Promise<void> => {
    const id = taskRef.current
    const targetAgent = agent ?? source.agent
    if (!targetAgent || !id || source.task_id !== id || source.role !== 'assistant') return
    if (messages.some((message) => message.status === 'streaming')) return
    const index = messages.findIndex((message) => message.id === source.id)
    if (index < 1 || messages[index - 1]?.role !== 'user') return
    const originalMessages = messages
    const prefix = messages.slice(0, index)
    const optimisticKey = ++optimisticSequence.current
    const temporaryAssistantId = `optimistic-retry-assistant-${optimisticKey}`
    const nextMessages: Message[] = [
      ...prefix,
      {
        id: temporaryAssistantId,
        task_id: id,
        role: 'assistant',
        agent: targetAgent,
        parts: [],
        created_at: new Date().toISOString(),
        status: 'streaming',
      },
    ]
    setError(null)
    markTaskWorking(id, true)
    setMessages(nextMessages)
    setTaskActivity(id, nextMessages.length)
    try {
      const result = await request<{ assistant_message_id: string }>('chat.retry', {
        task_id: id,
        message_id: source.id,
        agent: targetAgent,
      })
      setMessages((prev) =>
        reconcileAssistant(prev, temporaryAssistantId, result.assistant_message_id, targetAgent),
      )
      reconnectOtherAgents(id, targetAgent)
    } catch (err) {
      markTaskWorking(id, false)
      setMessages(originalMessages)
      setTaskActivity(id, originalMessages.length)
      fail(err)
    }
  }

  const cancel = useCallback(() => {
    if (!taskId || cancelling) return
    setCancelling(true)
    if (permission) {
      permission.resolve(null)
      setPermission(null)
    }
    request('chat.cancel', { task_id: taskId }).catch((err) => {
      setCancelling(false)
      fail(err)
    })
  }, [taskId, cancelling, permission, fail])

  const setConfig = useCallback(
    async (target: AgentId, configId: string, value: string | boolean) => {
      if (!taskId) return
      setSettingConfig(configId)
      setError(null)
      try {
        await request('agent.set_config', {
          task_id: taskId,
          agent: target,
          config_id: configId,
          value,
        })
        setError(null)
      } catch (err) {
        fail(err)
      } finally {
        setSettingConfig(null)
      }
    },
    [taskId, fail],
  )

  const resolvePermission = useCallback(
    (optionId: string | null) => {
      permission?.resolve({ option_id: optionId })
      setPermission(null)
    },
    [permission],
  )

  const task = taskId
    ? (Object.values(tasksByProject)
        .flat()
        .find((t) => t.id === taskId) ?? null)
    : null
  const draft = !task || isDraft(task)
  const draftProjectId = draft ? (task?.project_id ?? null) : null
  const optionsByAgent: Partial<Record<AgentId, AgentConfigOption[] | null>> = taskId
    ? Object.fromEntries(available.map((a) => [a.id, configs[pairKey(taskId, a.id)] ?? null]))
    : {}
  const statusByAgent: Partial<Record<AgentId, AgentStatus | null>> = taskId
    ? Object.fromEntries(available.map((a) => [a.id, statuses[pairKey(taskId, a.id)] ?? null]))
    : {}
  const providerStatusByAgent: Partial<Record<AgentId, AgentStatus | null>> = taskId
    ? Object.fromEntries(agents.map((a) => [a.id, statuses[pairKey(taskId, a.id)] ?? null]))
    : {}
  const streaming = messages.some((m) => m.status === 'streaming')
  const notice = coreExited ?? error

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        onToggle={toggleSidebar}
        settingsOpen={activeView === 'settings'}
        onOpenSettings={() => {
          setEditingMessage(null)
          setActiveView('settings')
        }}
        onBackToApp={() => setActiveView('chat')}
        projects={projects}
        tasksByProject={tasksByProject}
        workingTaskIds={workingTasks}
        selectedTaskId={activeView === 'chat' ? taskId : null}
        draft={activeView === 'chat' && draft}
        draftProjectId={draftProjectId}
        onNewChat={newChat}
        onSelectTask={selectTask}
        onAddProject={addProject}
        onUpdateProject={updateProject}
        onDeleteProject={deleteProject}
        onRenameTask={renameTask}
        onDeleteTask={deleteTask}
      />
      <main
        className={`main${activeView === 'settings' ? ' settings-open' : ''}`}
      >
        <header
          className={`titlebar main-titlebar${!sidebarOpen && isMac ? ' with-traffic-lights' : ''}`}
        >
          {!sidebarOpen && (
            <button
              type="button"
              className="icon-btn no-drag"
              onClick={toggleSidebar}
              title="Open sidebar"
              aria-label="Open sidebar"
            >
              <IconSidebarToggle open={false} size={18} />
            </button>
          )}
          <div className="main-title">
            {activeView === 'settings' ? 'Settings' : task && !draft ? task.title : 'New chat'}
          </div>
        </header>

        {activeView === 'settings' ? (
          <Settings
            agents={agents}
            enabled={enabledProviders}
            defaultProvider={defaultProvider}
            statusByAgent={providerStatusByAgent}
            scanning={scanningProviders}
            providerChangesLocked={workingTasks.size > 0}
            theme={theme}
            onEnabledChange={updateProviderEnabled}
            onDefaultChange={updateDefaultProvider}
            onRescan={() => void rescanProviders()}
            onOpenSetup={openProviderSetup}
            onThemeChange={updateTheme}
          />
        ) : (
          <div className={`chat-view${draft ? ' is-draft' : ''}`}>
            <Thread
              key={`thread-${taskId ?? NO_TASK}`}
              messages={messages}
              agents={agents}
              busy={streaming}
              permission={permission}
              onPermission={resolvePermission}
              editingMessage={editingMessage}
              onEdit={setEditingMessage}
              onCancelEdit={() => setEditingMessage(null)}
              onSubmitEdit={editAndResend}
              onRetry={(message) => void retry(message)}
              onContinue={() => void send('Continue from where you stopped.', [])}
              empty={
                draft ? (
                  <div className="hero">
                    <h1>What should we get done?</h1>
                  </div>
                ) : null
              }
            />

            {!editingMessage && (
              <Composer
                key={taskId ?? NO_TASK}
                draft={draft}
                hasChat={task !== null}
                projects={projects}
                draftProjectId={draftProjectId}
                onChooseProject={selectProject}
                onAddProject={addProject}
                agents={composerAgents}
                agent={agent}
                onAgentChange={chooseAgent}
                optionsByAgent={optionsByAgent}
                statusByAgent={statusByAgent}
                settingConfig={settingConfig}
                onSetConfig={setConfig}
                streaming={streaming}
                cancelling={cancelling}
                onSend={send}
                onCancel={cancel}
              />
            )}
          </div>
        )}

        {notice && (
          <div className={`toast${coreExited ? ' toast-error' : ''}`} role="alert">
            <span className="toast-text">{notice}</span>
            {!coreExited && (
              <button
                type="button"
                className="icon-btn small"
                onClick={() => setError(null)}
                aria-label="Dismiss"
              >
                <IconClose size={14} />
              </button>
            )}
          </div>
        )}
      </main>
      <ButtonTooltip />
    </div>
  )
}

function applyUpdate(prev: Message[], u: ChatUpdate, agent: AgentId | null): Message[] {
  const idx = prev.findIndex((m) => m.id === u.message_id)
  if (idx === -1) {
    const parts: Message['parts'] = []
    parts[u.part_index] = u.part
    return [
      ...prev,
      {
        id: u.message_id,
        task_id: u.task_id,
        role: 'assistant',
        agent,
        parts,
        created_at: new Date().toISOString(),
        status: 'streaming',
      },
    ]
  }
  const m = prev[idx]
  const parts = m.parts.slice()
  parts[u.part_index] = u.part
  const next = prev.slice()
  next[idx] = { ...m, parts }
  return next
}

function applyDone(prev: Message[], d: ChatDone, agent: AgentId | null): Message[] {
  const idx = prev.findIndex((m) => m.id === d.message_id)
  if (idx === -1) {
    return [
      ...prev,
      {
        id: d.message_id,
        task_id: d.task_id,
        role: 'assistant',
        agent,
        parts: d.status === 'error' && d.error ? [{ type: 'error', message: d.error }] : [],
        created_at: new Date().toISOString(),
        status: d.status,
        duration_ms: d.duration_ms ?? null,
      },
    ]
  }
  const next = prev.slice()
  const message = next[idx]
  const hasError = message.parts.some((part) => part?.type === 'error')
  const parts =
    d.status === 'error' && d.error && !hasError
      ? [...message.parts, { type: 'error' as const, message: d.error }]
      : message.parts
  next[idx] = { ...message, status: d.status, parts, duration_ms: d.duration_ms ?? null }
  return next
}

/** Merge the optimistic pair with core ids without losing an unusually early update/done. */
function reconcileSentMessages(
  prev: Message[],
  temporaryUserId: string,
  temporaryAssistantId: string,
  userMessageId: string,
  assistantMessageId: string,
  agent: AgentId,
): Message[] {
  const hasRealAssistant = prev.some((m) => m.id === assistantMessageId)
  return prev
    .filter((m) => m.id !== temporaryAssistantId || !hasRealAssistant)
    .map((m) => {
      if (m.id === temporaryUserId) return { ...m, id: userMessageId }
      if (m.id === temporaryAssistantId) return { ...m, id: assistantMessageId }
      if (m.id === assistantMessageId && !m.agent) return { ...m, agent }
      return m
    })
}

function reconcileAssistant(
  prev: Message[],
  temporaryAssistantId: string,
  assistantMessageId: string,
  agent: AgentId,
): Message[] {
  const hasRealAssistant = prev.some((message) => message.id === assistantMessageId)
  return prev
    .filter((message) => message.id !== temporaryAssistantId || !hasRealAssistant)
    .map((message) => {
      if (message.id === temporaryAssistantId) return { ...message, id: assistantMessageId }
      if (message.id === assistantMessageId && !message.agent) return { ...message, agent }
      return message
    })
}

function partsFrom(text: string, attachments: Attachment[]): Message['parts'] {
  return [
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
    ...attachments.map((attachment): Message['parts'][number] =>
      attachment.type === 'image'
        ? { type: 'image', mime_type: attachment.mime_type, data: attachment.data }
        : { type: 'file', path: attachment.path, name: basename(attachment.path) },
    ),
  ]
}
