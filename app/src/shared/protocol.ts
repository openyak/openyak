// Types copied from docs/core-protocol.md. Keep in sync with core.

export type AgentId = 'claude' | 'codex'
export type ThemePreference = 'system' | 'light' | 'dark'

export interface Agent {
  id: AgentId
  name: string
  available: boolean
  command: string
  /** Why the agent cannot be used right now, e.g. not signed in. */
  hint?: string
}

export interface Project {
  id: string
  name: string
  path: string
  created_at: string
}

export interface Task {
  id: string
  /** Null when the chat is not attached to a project. */
  project_id: string | null
  title: string
  created_at: string
  /** Last time a message was added or finished; task lists are sorted by it. */
  updated_at: string
  /** Messages in the chat; 0 is a new chat that has not started. */
  message_count: number
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
  /** Wall-clock response time for assistant messages; absent on user and legacy messages. */
  duration_ms?: number | null
  /** ACP StopReason of the reply: end_turn | max_tokens | max_turn_requests | refusal | cancelled. */
  stop_reason?: string | null
  /** ACP PromptResponse.usage verbatim, when the agent reports it. */
  usage?: unknown
}

export type Part =
  | {
      type: 'text'
      text: string
      /** Provider metadata such as Codex's commentary/final-answer phase. */
      _meta?: Record<string, unknown>
      message_id?: string
    }
  | { type: 'thought'; text: string; _meta?: Record<string, unknown>; message_id?: string }
  | {
      type: 'tool_call'
      id: string
      title: string
      kind: string
      status: string
      output?: string
      /** ACP ToolCallContent[] verbatim (content | diff | terminal); replaced by an update that carries content. */
      content?: unknown[]
      /** ACP ToolCallLocation[] verbatim. */
      locations?: unknown[]
      /** ACP raw_input / raw_output verbatim. */
      raw_input?: unknown
      raw_output?: unknown
      _meta?: Record<string, unknown>
    }
  | { type: 'error'; message: string }
  // ACP/extension events. Normalized artifact.* events are rendered; other kinds stay opaque.
  | { type: 'event'; kind: string; data: unknown }
  // Attachments on a user message. Images travel as base64; files by path.
  | { type: 'image'; mime_type: string; data: string }
  | { type: 'file'; path: string; name: string }

/**
 * An ACP session update (or extension notification) that arrived while no reply was
 * streaming for the (task, agent) pair, e.g. the slash-command list sent when a session
 * opens. Stored by core, listed with `chat.events`, announced with `chat.event`.
 */
export interface AgentEvent {
  id: string
  task_id: string
  agent: AgentId
  kind: string
  data: unknown
  created_at: string
}

/** ACP command advertised by the active agent. Skill commands conventionally start with `$`. */
export interface AvailableCommand {
  name: string
  description: string
  input?: { hint?: string }
  _meta?: Record<string, unknown>
}

export interface CodexSkillSummary {
  name: string
  description: string
  path: string
  enabled: boolean
  pluginId: string | null
}

export interface CodexMcpServerSummary {
  name: string
  pluginId: string | null
  status: string
  toolCount: number
}

export interface CodexHostCapabilities {
  skills: CodexSkillSummary[]
  mcpServers: CodexMcpServerSummary[]
  appCount: number
  errors: string[]
}

export interface ArtifactPreview {
  path: string
  name: string
  extension: string
  size: number
  previewUrl: string
  /** Text preview capped by the desktop host; null for binary files. */
  content: string | null
  truncated: boolean
  /** Host-converted semantic HTML for document formats such as DOCX. */
  renderedHtml?: string
  /** Official published page, when the Agent supplied one. */
  sourceUrl?: string
  title?: string
  artifactId?: string
  version?: string
}

/** Provider-neutral reference carried by normalized `artifact.*` event Parts. */
export interface ArtifactReference {
  id?: string
  path?: string
  url?: string
  title?: string
  version?: string
  contract?: string
  audience?: string
  live_subscription?: string
  capabilities?: unknown
}

export interface ArtifactEventData {
  schema_version: 1
  tool_call_id: string
  operation: string
  artifact?: ArtifactReference | null
  artifacts?: ArtifactReference[]
  asset?: unknown
  [key: string]: unknown
}

/** Provider-neutral file location written in assistant Markdown. */
export interface ProjectFileReference {
  path: string
  line?: number
  column?: number
}

export interface ResolvedProjectFile extends ProjectFileReference {
  /** Canonical absolute path, validated to be inside the active project. */
  path: string
  relativePath: string
  name: string
  extension: string
  size: number
}

export interface ProjectFilePreview extends ResolvedProjectFile {
  /** Short-lived URL served by the desktop host for browser-renderable files. */
  previewUrl: string
  /** Null for binary files. Text is capped by the desktop host. */
  content: string | null
  truncated: boolean
  /** Host-converted semantic HTML for document formats such as DOCX. */
  renderedHtml?: string
}

/** What the app attaches to a message; becomes image/file Parts and ACP content blocks. */
export type Attachment =
  | { type: 'image'; mime_type: string; data: string }
  | { type: 'file'; path: string }

// A session config option exactly as the agent advertises it (model, effort, mode, …).
// The app renders these and passes choices straight back; it never interprets them.

interface AgentConfigOptionBase {
  id: string
  name: string
  description?: string
  category?: string
}

export interface AgentConfigSelectOption {
  value: string
  name: string
  description?: string
  group?: string
  /** The agent advertised this value but definitively rejected it for this session. */
  disabled?: boolean
  disabled_reason?: string
  /** Agent-provided hint for modes: standard, auto_review, full_access, plan, … */
  kind?: string
}

export type AgentConfigOption =
  | (AgentConfigOptionBase & {
      type: 'select'
      current_value: string
      options: AgentConfigSelectOption[]
    })
  | (AgentConfigOptionBase & { type: 'boolean'; current_value: boolean })
  | (AgentConfigOptionBase & { type: 'unknown' })

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
  duration_ms?: number
  error?: string
  /** ACP PromptResponse fields verbatim; status stays 'done' for max_tokens, max_turn_requests and refusal. */
  stop_reason?: string
  usage?: unknown
  _meta?: Record<string, unknown>
}

export interface AgentStatus {
  task_id: string
  agent: AgentId
  state: 'starting' | 'ready' | 'exited'
  detail?: string
}

export interface AgentConfig {
  task_id: string
  agent: AgentId
  options: AgentConfigOption[]
}

export type Notification =
  | { method: 'chat.update'; params: ChatUpdate }
  | { method: 'chat.done'; params: ChatDone }
  | { method: 'chat.event'; params: AgentEvent }
  | { method: 'agent.status'; params: AgentStatus }
  | { method: 'agent.config'; params: AgentConfig }
  | { method: string; params: unknown }

// Requests (core → app)

export interface PermissionOption {
  id: string
  label: string
  kind: string
  _meta?: Record<string, unknown>
}

export interface PermissionRequest {
  request_id: string
  task_id: string
  agent: AgentId
  title: string
  options: PermissionOption[]
  /** The ACP ToolCallUpdate of the request verbatim: title, kind, status, content incl. diffs, locations, rawInput, rawOutput, _meta. */
  tool_call: unknown
  /** The request's own meta. */
  _meta?: Record<string, unknown>
}

export interface PermissionResponse {
  option_id: string | null
}

/** Primitive JSON Schema subset defined by ACP elicitation. Unknown extension fields pass through. */
export interface ElicitationPropertySchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  title?: string
  description?: string
  default?: string | number | boolean | string[]
  oneOf?: ElicitationEnumOption[]
  enum?: Array<string | number>
  items?: {
    anyOf?: ElicitationEnumOption[]
    enum?: Array<string | number>
    [key: string]: unknown
  }
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface ElicitationEnumOption {
  const?: string | number
  title?: string
  description?: string
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

interface ElicitationRequestBase {
  request_id: string
  task_id: string
  agent: AgentId
  message: string
  sessionId?: string
  toolCallId?: string
  _meta?: Record<string, unknown>
}

export interface FormElicitationRequest extends ElicitationRequestBase {
  mode: 'form'
  requestedSchema: {
    type: 'object'
    properties?: Record<string, ElicitationPropertySchema>
    required?: string[]
    [key: string]: unknown
  }
}

export interface UrlElicitationRequest extends ElicitationRequestBase {
  mode: 'url'
  url: string
  elicitationId: string
}

export type ElicitationRequest = FormElicitationRequest | UrlElicitationRequest

export type ElicitationResponse =
  | { action: 'accept'; content?: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' }

// Bridge exposed by the preload as window.openyak

export interface CoreExit {
  code: number | null
  signal: string | null
}

export interface OpenYakApi {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  onNotification(cb: (n: Notification) => void): () => void
  onPermissionRequest(cb: (req: PermissionRequest) => Promise<PermissionResponse | null>): () => void
  onElicitationRequest(cb: (req: ElicitationRequest) => Promise<ElicitationResponse | null>): () => void
  onCoreExited(cb: (exit: CoreExit) => void): () => void
  pickDirectory(): Promise<string | null>
  /** Files and/or folders chosen in the OS dialog; empty when cancelled. */
  pickFiles(): Promise<string[]>
  /** Save a rendered Mermaid diagram using the native OS dialog. */
  saveDiagram(svg: string): Promise<boolean>
  /** Save a user-attached image using the native OS dialog. */
  saveImage(image: { mimeType: string; data: string; suggestedName?: string }): Promise<boolean>
  /** Open a trusted HTTPS setup page in the user's default browser. */
  openExternal(url: string): Promise<void>
  /** Resolve a Markdown candidate without granting access outside the active project. */
  resolveProjectFile(
    projectPath: string | null,
    reference: ProjectFileReference,
  ): Promise<ResolvedProjectFile | null>
  inspectProjectFile(
    projectPath: string | null,
    reference: ProjectFileReference,
  ): Promise<ProjectFilePreview>
  openProjectFile(projectPath: string | null, reference: ProjectFileReference): Promise<void>
  revealProjectFile(projectPath: string | null, reference: ProjectFileReference): Promise<void>
  /** Inventory from the public Codex App Server used by the official desktop host. */
  codexCapabilities(projectPath?: string | null): Promise<CodexHostCapabilities>
  setCodexSkillEnabled(path: string, enabled: boolean): Promise<boolean>
  /** Validate a generated file against its project and create a short-lived preview URL. */
  inspectArtifact(
    taskId: string,
    projectPath: string | null,
    artifact: ArtifactReference,
  ): Promise<ArtifactPreview>
  openArtifact(taskId: string, projectPath: string | null, filePath: string): Promise<void>
  revealArtifact(taskId: string, projectPath: string | null, filePath: string): Promise<void>
  /** Apply the user's theme to Electron chrome and the renderer. */
  setTheme(theme: ThemePreference): Promise<void>
  /** On-disk path of a dropped or pasted File, or '' when it has none (clipboard images). */
  pathForFile(file: File): string
}

declare global {
  interface Window {
    openyak: OpenYakApi
  }
}
