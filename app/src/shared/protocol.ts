// Types copied from docs/core-protocol.md. Keep in sync with core.

export type AgentId = 'claude' | 'codex'

export interface Agent {
  id: AgentId
  name: string
  available: boolean
  command: string
}

export interface Project {
  id: string
  name: string
  path: string
  created_at: string
}

export interface Task {
  id: string
  project_id: string
  title: string
  created_at: string
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'cancelled'

export interface Message {
  id: string
  task_id: string
  role: 'user' | 'assistant'
  agent: AgentId | null
  parts: Part[]
  created_at: string
  status: MessageStatus
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; id: string; title: string; kind: string; status: string; output?: string }
  | { type: 'error'; message: string }

// Notifications (core → app)

export interface ChatUpdate {
  task_id: string
  message_id: string
  part_index: number
  part: Part
}

export interface ChatDone {
  task_id: string
  message_id: string
  status: 'done' | 'error' | 'cancelled'
  error?: string
}

export interface AgentStatus {
  task_id: string
  agent: AgentId
  state: 'starting' | 'ready' | 'exited'
  detail?: string
}

export type Notification =
  | { method: 'chat.update'; params: ChatUpdate }
  | { method: 'chat.done'; params: ChatDone }
  | { method: 'agent.status'; params: AgentStatus }
  | { method: string; params: unknown }

// Requests (core → app)

export interface PermissionOption {
  id: string
  label: string
  kind: string
}

export interface PermissionRequest {
  request_id: string
  task_id: string
  agent: AgentId
  title: string
  options: PermissionOption[]
}

export interface PermissionResponse {
  option_id: string | null
}

// Bridge exposed by the preload as window.openyak

export interface CoreExit {
  code: number | null
  signal: string | null
}

export interface OpenYakApi {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  onNotification(cb: (n: Notification) => void): () => void
  onPermissionRequest(cb: (req: PermissionRequest) => Promise<PermissionResponse | null>): () => void
  onCoreExited(cb: (exit: CoreExit) => void): () => void
  pickDirectory(): Promise<string | null>
}

declare global {
  interface Window {
    openyak: OpenYakApi
  }
}
