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
} from '../../shared/protocol'
import { request } from './api'
import { Sidebar } from './Sidebar'
import { Thread } from './Thread'
import { Composer } from './Composer'
import { IconClose, IconSidebar } from './icons'
import { titleFrom } from './format'

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
const SIDEBAR_KEY = 'openyak.sidebar'
const isMac = navigator.platform.startsWith('Mac')

function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed'
  } catch {
    return true
  }
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([])
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
  const [coreExited, setCoreExited] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebar)

  // Latest values, readable from handlers and callbacks without re-creating them.
  const taskRef = useRef<string | null>(null)
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

  const fail = useCallback((err: unknown) => setError(String(err)), [])

  const loadTasks = useCallback(async (projectId: string): Promise<Task[]> => {
    const t = await request<Task[]>('task.list', { project_id: projectId })
    setTasksByProject((prev) => ({ ...prev, [projectId]: t }))
    return t
  }, [])

  /**
   * Open the chat a new message in `projectId` will start in, creating a draft task if
   * the project has none. Its sessions come up right away, so the picker shows real
   * models and effort levels before anything is sent.
   */
  const openDraft = useCallback(async (projectId: string, known?: Task[]) => {
    const list = known ?? tasksRef.current[projectId] ?? []
    let task = list.find((t) => t.message_count === 0) ?? null
    if (!task) {
      const created = await request<Task>('task.create', {
        project_id: projectId,
        title: 'New chat',
      })
      task = created
      setTasksByProject((prev) => ({
        ...prev,
        [projectId]: [created, ...(prev[projectId] ?? [])],
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
    setTasksByProject((prev) => ({
      ...prev,
      [task.project_id]: (prev[task.project_id] ?? []).filter((t) => t.id !== task.id),
    }))
    request('task.delete', { task_id: task.id }).catch(() => {})
  }, [])

  // Initial load: agents, projects, every project's tasks, then a new chat to start in.
  useEffect(() => {
    request<Agent[]>('agent.list').then(setAgents).catch(fail)
    request<Project[]>('project.list')
      .then(async (ps) => {
        setProjects(ps)
        const lists = await Promise.all(ps.map((p) => loadTasks(p.id)))
        if (ps[0]) await openDraft(ps[0].id, lists[0])
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

  // Core notifications, permission requests, and exit.
  useEffect(() => {
    const offNotification = window.openyak.onNotification((n) => {
      if (import.meta.env.DEV) console.log(`[rpc ⇠] ${n.method}`, JSON.stringify(n.params))
      switch (n.method) {
        case 'chat.update': {
          const u = n.params as ChatUpdate
          if (u.task_id !== taskRef.current) return
          setMessages((prev) => applyUpdate(prev, u))
          return
        }
        case 'chat.done': {
          const d = n.params as ChatDone
          bumpTask(d.task_id)
          if (d.task_id !== taskRef.current) return
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== d.message_id) return m
              const parts =
                d.status === 'error' && d.error
                  ? [...m.parts, { type: 'error' as const, message: d.error }]
                  : m.parts
              return { ...m, status: d.status, parts }
            }),
          )
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
      setCoreExited(
        `Core exited (code ${exit.code ?? '-'}, signal ${exit.signal ?? '-'}). Restart OpenYak.`,
      )
    })
    return () => {
      offNotification()
      offPermission()
      offExit()
    }
  }, [bumpTask])

  // The agent the next message goes to: the explicit pick for this chat, else the agent
  // that last served it, else the first one installed.
  const available = agents.filter((a) => a.available)
  const isAvailable = (id: AgentId | null | undefined): id is AgentId =>
    !!id && available.some((a) => a.id === id)
  const chosen = agentChoice[taskId ?? NO_TASK]
  const lastUsed = [...messages].reverse().find((m) => isAvailable(m.agent))?.agent
  const agent: AgentId | null = isAvailable(chosen)
    ? chosen
    : isAvailable(lastUsed)
      ? lastUsed
      : (available[0]?.id ?? null)

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
    const current = currentTask()
    if (isDraft(current)) return
    const pid = current?.project_id ?? projectsRef.current[0]?.id
    if (!pid) return
    void openDraft(pid).catch(fail)
  }, [currentTask, openDraft, fail])

  const selectTask = useCallback(
    (id: string) => {
      if (id === taskRef.current) return
      dropIfDraft(taskRef.current)
      setTaskId(id)
      setMessages([])
    },
    [dropIfDraft],
  )

  const selectProject = useCallback(
    (pid: string) => {
      const current = currentTask()
      if (current && isDraft(current) && current.project_id === pid) return
      dropIfDraft(taskRef.current)
      void openDraft(pid).catch(fail)
    },
    [currentTask, dropIfDraft, openDraft, fail],
  )

  const addProject = useCallback(async () => {
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

  const chooseAgent = useCallback(
    (id: AgentId) => setAgentChoice((prev) => ({ ...prev, [taskId ?? NO_TASK]: id })),
    [taskId],
  )

  // Not memoized: the React Compiler lint cannot prove `agent` stable across the
  // attachment handling below, and nothing downstream is memoized anyway.
  const send = async (text: string, attachments: Attachment[]) => {
    const id = taskRef.current
    if (!agent || !id) return
    try {
      if (isDraft(currentTask())) {
        // The first message names the chat and makes it appear in the sidebar.
        const firstFile = attachments.find((a) => a.type === 'file')
        const title = text.trim()
          ? titleFrom(text)
          : firstFile
            ? basename(firstFile.path)
            : 'Image'
        const renamed = await request<Task>('task.rename', { task_id: id, title })
        setTasksByProject((prev) => ({
          ...prev,
          [renamed.project_id]: (prev[renamed.project_id] ?? []).map((t) =>
            t.id === id ? { ...t, title: renamed.title } : t,
          ),
        }))
      }
      const r = await request<{ user_message_id: string; assistant_message_id: string }>(
        'chat.send',
        attachments.length ? { task_id: id, agent, text, attachments } : { task_id: id, agent, text },
      )
      const now = new Date().toISOString()
      const parts: Message['parts'] = [
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
        ...attachments.map((a): Message['parts'][number] =>
          a.type === 'image'
            ? { type: 'image', mime_type: a.mime_type, data: a.data }
            : { type: 'file', path: a.path, name: basename(a.path) },
        ),
      ]
      setMessages((prev) => [
        ...prev,
        {
          id: r.user_message_id,
          task_id: id,
          role: 'user',
          agent,
          parts,
          created_at: now,
          status: 'done',
        },
        {
          id: r.assistant_message_id,
          task_id: id,
          role: 'assistant',
          agent,
          parts: [],
          created_at: now,
          status: 'streaming',
        },
      ])
      bumpTask(id, 2)
    } catch (err) {
      fail(err)
    }
  }

  const cancel = useCallback(() => {
    if (!taskId) return
    request('chat.cancel', { task_id: taskId }).catch(fail)
  }, [taskId, fail])

  const setConfig = useCallback(
    async (target: AgentId, configId: string, value: string | boolean) => {
      if (!taskId) return
      setSettingConfig(configId)
      try {
        await request('agent.set_config', {
          task_id: taskId,
          agent: target,
          config_id: configId,
          value,
        })
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
  const draftProjectId = draft ? (task?.project_id ?? projects[0]?.id ?? null) : null
  const optionsByAgent: Partial<Record<AgentId, AgentConfigOption[] | null>> = taskId
    ? Object.fromEntries(available.map((a) => [a.id, configs[pairKey(taskId, a.id)] ?? null]))
    : {}
  const statusByAgent: Partial<Record<AgentId, AgentStatus | null>> = taskId
    ? Object.fromEntries(available.map((a) => [a.id, statuses[pairKey(taskId, a.id)] ?? null]))
    : {}
  const streaming = messages.some((m) => m.status === 'streaming')
  const notice = coreExited ?? error

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        onToggle={toggleSidebar}
        projects={projects}
        tasksByProject={tasksByProject}
        selectedTaskId={taskId}
        draft={draft}
        draftProjectId={draftProjectId}
        onNewChat={newChat}
        onSelectTask={selectTask}
        onSelectProject={selectProject}
        onAddProject={addProject}
      />
      <main className="main">
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
              <IconSidebar size={18} />
            </button>
          )}
          <div className="main-title">{task && !draft ? task.title : 'New chat'}</div>
        </header>

        <Thread
          messages={messages}
          agents={agents}
          permission={permission}
          onPermission={resolvePermission}
          empty={
            draft ? (
              <div className="hero">
                <h1>What should we get done?</h1>
              </div>
            ) : null
          }
        />

        <Composer
          draft={draft}
          hasChat={task !== null}
          projects={projects}
          draftProjectId={draftProjectId}
          onChooseProject={selectProject}
          onAddProject={addProject}
          agents={agents}
          agent={agent}
          onAgentChange={chooseAgent}
          optionsByAgent={optionsByAgent}
          statusByAgent={statusByAgent}
          settingConfig={settingConfig}
          onSetConfig={setConfig}
          streaming={streaming}
          onSend={send}
          onCancel={cancel}
        />

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
    </div>
  )
}

function applyUpdate(prev: Message[], u: ChatUpdate): Message[] {
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
        agent: null,
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
