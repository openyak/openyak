import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Agent,
  AgentId,
  AgentStatus,
  ChatDone,
  ChatUpdate,
  Message,
  PermissionRequest,
  PermissionResponse,
  Project,
  Task,
} from '../../shared/protocol'
import { request } from './api'
import { ProjectsColumn } from './ProjectsColumn'
import { TasksColumn } from './TasksColumn'
import { Chat } from './Chat'

export interface PendingPermission {
  request: PermissionRequest
  resolve: (res: PermissionResponse | null) => void
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskId, setTaskId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const [coreExited, setCoreExited] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Current task id, readable from notification handlers without re-subscribing.
  const taskRef = useRef<string | null>(null)
  useEffect(() => {
    taskRef.current = taskId
  }, [taskId])

  const fail = useCallback((err: unknown) => setError(String(err)), [])

  // Initial load.
  useEffect(() => {
    request<Agent[]>('agent.list').then(setAgents).catch(fail)
    request<Project[]>('project.list').then(setProjects).catch(fail)
  }, [fail])

  // Load tasks when the project changes.
  useEffect(() => {
    if (!projectId) return
    let live = true
    request<Task[]>('task.list', { project_id: projectId })
      .then((t) => {
        if (live) setTasks(t)
      })
      .catch(fail)
    return () => {
      live = false
    }
  }, [projectId, fail])

  // Load history when the task changes.
  useEffect(() => {
    if (!taskId) return
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
          if (s.task_id === taskRef.current) setAgentStatus(s)
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
      setCoreExited(`core exited (code ${exit.code ?? '-'}, signal ${exit.signal ?? '-'})`)
    })
    return () => {
      offNotification()
      offPermission()
      offExit()
    }
  }, [])

  const selectProject = useCallback((id: string) => {
    setProjectId(id)
    setTaskId(null)
    setTasks([])
    setMessages([])
    setAgentStatus(null)
  }, [])

  const selectTask = useCallback((id: string) => {
    setTaskId(id)
    setMessages([])
    setAgentStatus(null)
  }, [])

  const addProject = useCallback(async () => {
    const dir = await window.openyak.pickDirectory()
    if (!dir) return
    try {
      const p = await request<Project>('project.create', { name: basename(dir), path: dir })
      setProjects((prev) => [...prev, p])
      selectProject(p.id)
    } catch (err) {
      fail(err)
    }
  }, [selectProject, fail])

  const addTask = useCallback(
    async (title: string) => {
      if (!projectId) return
      try {
        const t = await request<Task>('task.create', { project_id: projectId, title })
        setTasks((prev) => [...prev, t])
        selectTask(t.id)
      } catch (err) {
        fail(err)
      }
    },
    [projectId, selectTask, fail],
  )

  const send = useCallback(
    async (agent: AgentId, text: string) => {
      if (!taskId) return
      try {
        const r = await request<{ user_message_id: string; assistant_message_id: string }>(
          'chat.send',
          { task_id: taskId, agent, text },
        )
        const now = new Date().toISOString()
        setMessages((prev) => [
          ...prev,
          {
            id: r.user_message_id,
            task_id: taskId,
            role: 'user',
            agent,
            parts: [{ type: 'text', text }],
            created_at: now,
            status: 'done',
          },
          {
            id: r.assistant_message_id,
            task_id: taskId,
            role: 'assistant',
            agent,
            parts: [],
            created_at: now,
            status: 'streaming',
          },
        ])
      } catch (err) {
        fail(err)
      }
    },
    [taskId, fail],
  )

  const cancel = useCallback(() => {
    if (!taskId) return
    request('chat.cancel', { task_id: taskId }).catch(fail)
  }, [taskId, fail])

  const resolvePermission = useCallback(
    (optionId: string | null) => {
      permission?.resolve({ option_id: optionId })
      setPermission(null)
    },
    [permission],
  )

  const project = projects.find((p) => p.id === projectId) ?? null
  const task = tasks.find((t) => t.id === taskId) ?? null

  return (
    <div className="app">
      <div className="columns">
        <ProjectsColumn
          projects={projects}
          selectedId={projectId}
          onSelect={selectProject}
          onAdd={addProject}
        />
        <TasksColumn
          project={project}
          tasks={tasks}
          selectedId={taskId}
          onSelect={selectTask}
          onAdd={addTask}
        />
        <Chat
          task={task}
          agents={agents}
          messages={messages}
          permission={permission}
          onSend={send}
          onCancel={cancel}
          onPermission={resolvePermission}
        />
      </div>
      {coreExited && <div className="banner banner-error">{coreExited}. Restart OpenYak.</div>}
      {error && (
        <div className="banner banner-warn">
          <span className="banner-text">{error}</span>
          <button className="linkish" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      <div className="statusline">
        {agentStatus
          ? `${agentStatus.agent}: ${agentStatus.state}${agentStatus.detail ? ` — ${agentStatus.detail}` : ''}`
          : task
            ? 'idle'
            : ''}
      </div>
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
