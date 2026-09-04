import { createRequire } from 'node:module'
import { JsonRpcProcess } from './json-rpc.ts'
import {
  array,
  object,
  string,
  questionForm,
  selectOption,
  type NativeDriver,
  type OpenParams,
  type ObjectValue,
  type RuntimeSink,
} from './protocol.ts'
import type { Part } from '../../shared/protocol'

const require = createRequire(import.meta.url)
export class CodexDriver implements NativeDriver {
  private rpc: JsonRpcProcess | null = null
  private threadId = ''
  private turnId = ''
  private cwd = ''
  private values: ObjectValue = {}
  private defaultPolicy: ObjectValue = {}
  private models: ObjectValue[] = []
  private skills: ObjectValue[] = []
  private parts = new Map<string, Part>()
  private children = new Set<string>()
  private pending: {
    resolve: (v: ObjectValue) => void
    reject: (e: Error) => void
  } | null = null
  private cancelRequested = false
  private approvals = new Map<string, AbortController>()
  private sink: RuntimeSink
  constructor(sink: RuntimeSink) {
    this.sink = sink
  }
  async open(p: OpenParams) {
    this.cwd = p.cwd
    this.values = p.config ?? {}
    const binary = process.env.OPENYAK_CODEX_BIN
    this.rpc = new JsonRpcProcess(
      binary || process.execPath,
      binary
        ? ['app-server']
        : [require.resolve('@openai/codex/bin/codex.js'), 'app-server'],
      (message) => {
        this.receive(message)
      },
      (error) => {
        this.pending?.reject(error)
        this.pending = null
        this.abortRequests()
      },
    )
    const init = await this.rpc.request('initialize', {
      clientInfo: {
        name: 'openyak',
        title: 'OpenYak',
        version: '2.0.0-alpha.0',
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.rpc.send({ method: 'initialized' })
    this.sink.event('session.capabilities', {
      transport: 'codex-app-server',
      ...init,
    })
    let cursor: unknown = undefined
    do {
      const models = await this.rpc.request('model/list', {
        ...(cursor ? { cursor } : {}),
      })
      this.models.push(...array(models.data))
      cursor = models.nextCursor
    } while (cursor)
    const opened = await this.rpc.request(
      p.sessionId ? 'thread/resume' : 'thread/start',
      {
        ...(p.sessionId ? { threadId: p.sessionId } : {}),
        cwd: p.cwd,
        ...this.threadOptions(),
      },
    )
    this.threadId = string(object(opened.thread).id)
    this.defaultPolicy = {
      approvalPolicy: opened.approvalPolicy,
      sandboxPolicy: opened.sandbox,
    }
    if (!this.threadId) throw new Error('Codex returned no thread ID')
    this.values.model ??=
      opened.model ??
      this.models.find((m) => m.isDefault)?.id ??
      this.models[0]?.id
    this.values.thought_level ??=
      opened.reasoningEffort ?? this.model().defaultReasoningEffort
    this.emitConfig()
    await this.loadSkills()
    return { sessionId: this.threadId }
  }
  private async loadSkills() {
    const response = await this.rpc!.request('skills/list', {
      cwds: [this.cwd],
    })
    this.skills = array(response.data)
      .flatMap((entry) => array(entry.skills))
      .filter((skill) => skill.enabled !== false)
    this.sink.event('session.skills', response)
    this.sink.event('available_commands_update', {
      availableCommands: this.skills.map((skill) => ({
        name: `$${string(skill.name)}`,
        description: string(skill.description),
        input: { hint: 'Instructions' },
      })),
    })
  }
  private model() {
    return (
      this.models.find(
        (m) => m.id === this.values.model || m.model === this.values.model,
      ) ?? {}
    )
  }
  private threadOptions() {
    const mode = this.values.mode
    return {
      ...(this.values.model ? { model: this.values.model } : {}),
      ...(mode === 'full-access'
        ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
        : mode === 'read-only'
          ? { approvalPolicy: 'on-request', sandbox: 'read-only' }
          : mode === 'auto' || mode === 'agent'
            ? { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
            : {}),
    }
  }
  private emitConfig() {
    const efforts = array(this.model().supportedReasoningEfforts)
    this.sink.config([
      selectOption(
        'model',
        'Model',
        'model',
        string(this.values.model),
        this.models.map((m) => ({
          value: string(m.id),
          name: string(m.displayName) || string(m.id),
        })),
      ),
      selectOption(
        'thought_level',
        'Reasoning',
        'thought_level',
        string(this.values.thought_level),
        efforts.map((e) => ({
          value: string(e.reasoningEffort),
          name: string(e.reasoningEffort),
        })),
      ),
      selectOption(
        'mode',
        'Permissions',
        'mode',
        string(this.values.mode) || 'provider-default',
        [
          { value: 'provider-default', name: 'Session defaults' },
          { value: 'read-only', name: 'Read only' },
          { value: 'auto', name: 'Ask for approval' },
          { value: 'full-access', name: 'Full access' },
        ],
      ),
    ])
  }
  async configure(id: string, value: unknown) {
    if (this.pending) throw new Error('Message is running')
    if (id === 'model' && !this.models.some((m) => m.id === value))
      throw new Error('Unknown Codex model')
    if (
      id === 'thought_level' &&
      !array(this.model().supportedReasoningEfforts).some(
        (e) => e.reasoningEffort === value,
      )
    )
      throw new Error('Unsupported reasoning effort')
    if (!['model', 'thought_level', 'mode'].includes(id))
      throw new Error('Unsupported setting')
    if (
      id === 'mode' &&
      ![
        'provider-default',
        'read-only',
        'auto',
        'agent',
        'full-access',
      ].includes(string(value))
    )
      throw new Error('Unsupported permission mode')
    this.values[id] = value
    if (id === 'model')
      this.values.thought_level = this.model().defaultReasoningEffort
    this.emitConfig()
  }
  async prompt(blocks: ObjectValue[]): Promise<ObjectValue> {
    if (this.pending) throw new Error('A message is already running')
    this.parts.clear()
    this.turnId = ''
    this.cancelRequested = false
    const input = blocks.flatMap<ObjectValue>((b) =>
      b.type === 'text'
        ? [{ type: 'text', text: b.text }]
        : b.type === 'image'
          ? [{ type: 'image', url: `data:${b.mimeType};base64,${b.data}` }]
          : b.type === 'resource_link'
            ? [{ type: 'text', text: `Attached file: ${b.uri}` }]
            : [],
    )
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => string(b.text))
      .join('\n')
    for (const skill of this.skills) {
      const name = string(skill.name)
      if (text.split(/\s+/).includes(`$${name}`))
        input.push({ type: 'skill', name, path: skill.path })
    }
    const completion = new Promise<ObjectValue>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
    const options = this.threadOptions()
    const sandbox = options.sandbox
    // turn/start uses SandboxPolicy, while thread/start uses SandboxMode.
    const { sandbox: _sandbox, ...turnOptions } = options
    void _sandbox
    void this.rpc!.request('turn/start', {
      threadId: this.threadId,
      input,
      ...turnOptions,
      ...(sandbox ? {} : this.defaultPolicy),
      ...(sandbox
        ? {
            sandboxPolicy:
              sandbox === 'danger-full-access'
                ? { type: 'dangerFullAccess' }
                : sandbox === 'read-only'
                  ? { type: 'readOnly', networkAccess: false }
                  : {
                      type: 'workspaceWrite',
                      writableRoots: [this.cwd],
                      networkAccess: false,
                      excludeTmpdirEnvVar: false,
                      excludeSlashTmp: false,
                    },
          }
        : {}),
      ...(this.values.thought_level
        ? { effort: this.values.thought_level }
        : {}),
    })
      .then((r) => {
        this.turnId = string(object(r.turn).id)
        if (this.cancelRequested)
          void this.cancel().catch((e) =>
            this.sink.event('runtime.error', { message: String(e) }),
          )
      })
      .catch((e) => {
        this.pending?.reject(e)
        this.pending = null
      })
    return completion
  }
  private receive(m: ObjectValue) {
    const p = object(m.params),
      method = string(m.method),
      tid = string(p.threadId)
    this.sink.event('provider.raw', m, tid)
    if (method === 'skills/changed')
      void this.loadSkills().catch((error) =>
        this.sink.event('runtime.error', { message: String(error) }),
      )
    if (m.id !== undefined) {
      void this.request(m).catch((error) =>
        this.rpc?.send({
          id: m.id,
          error: { code: -32603, message: String(error) },
        }),
      )
      return
    }
    if (method === 'serverRequest/resolved') {
      this.approvals.get(String(p.requestId))?.abort()
      return
    }
    if (method === 'thread/started') {
      const thread = object(p.thread)
      const source = object(thread.source),
        sub = object(source.subAgent),
        spawned = object(sub.thread_spawn)
      const parent =
        string(thread.parentThreadId) || string(spawned.parent_thread_id)
      if (parent) {
        this.children.add(string(thread.id))
        this.sink.event(
          'agent.updated',
          {
            id: thread.id,
            parentId: parent,
            name: thread.agentNickname || thread.name || thread.id,
            status: object(thread.status).type || 'running',
            model: thread.model,
          },
          string(thread.id),
        )
      }
    }
    if (tid && this.threadId && tid !== this.threadId) {
      this.sink.event(
        'agent.updated',
        {
          id: tid,
          status:
            method === 'turn/completed' ? object(p.turn).status : 'running',
          activity: { method, params: p },
        },
        tid,
      )
      return
    }
    if (method === 'turn/started') {
      this.turnId = string(object(p.turn).id)
      if (this.cancelRequested)
        void this.cancel().catch((e) =>
          this.sink.event('runtime.error', { message: String(e) }),
        )
    }
    if (method === 'turn/completed') {
      const turn = object(p.turn),
        error = object(turn.error)
      if (turn.status === 'failed')
        this.pending?.reject(
          new Error(string(error.message) || 'Codex message failed'),
        )
      else
        this.pending?.resolve({
          stopReason: turn.status === 'interrupted' ? 'cancelled' : 'end_turn',
        })
      this.pending = null
      this.turnId = ''
      this.abortRequests()
    }
    if (method === 'item/started' || method === 'item/completed')
      this.item(object(p.item), method === 'item/completed')
    if (
      method === 'item/agentMessage/delta' ||
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta'
    ) {
      const key = string(p.itemId),
        thought = method !== 'item/agentMessage/delta',
        old = this.parts.get(key)
      const part: Part = {
        type: thought ? 'thought' : 'text',
        text:
          (old?.type === 'text' || old?.type === 'thought' ? old.text : '') +
          string(p.delta),
        message_id: key,
        ...(old && '_meta' in old ? { _meta: old._meta } : {}),
      }
      this.put(key, part)
    }
    if (method === 'item/commandExecution/outputDelta') {
      const key = string(p.itemId),
        old = this.parts.get(key)
      if (old?.type === 'tool_call')
        this.put(key, { ...old, output: (old.output || '') + string(p.delta) })
    }
    if (method === 'thread/tokenUsage/updated')
      this.sink.event('usage.updated', p)
    if (method === 'turn/plan/updated') this.sink.event('plan.updated', p)
  }
  private put(key: string, part: Part) {
    this.parts.set(key, part)
    this.sink.part(key, part)
  }
  private item(item: ObjectValue, done: boolean) {
    const id = string(item.id),
      type = string(item.type)
    if (type === 'agentMessage') {
      const old = this.parts.get(id)
      this.put(id, {
        type: 'text',
        text: string(item.text) || (old?.type === 'text' ? old.text : ''),
        message_id: id,
        _meta: { codex: { phase: item.phase } },
      })
      return
    }
    if (type === 'reasoning') {
      const text = Array.isArray(item.summary)
        ? item.summary
            .map((v) => (typeof v === 'string' ? v : string(object(v).text)))
            .join('\n')
        : ''
      if (text) this.put(id, { type: 'thought', text, message_id: id })
      return
    }
    if (type === 'userMessage') return
    if (type === 'subAgentActivity') {
      this.sink.event('agent.updated', {
        id: item.agentThreadId,
        parentId: this.threadId,
        name: item.agentPath,
        activity: item,
      })
    }
    if (type === 'collabAgentToolCall') {
      const states = object(item.agentsStates)
      const ids = new Set([
        ...Object.keys(states),
        ...(Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.filter(
              (v): v is string => typeof v === 'string',
            )
          : []),
      ])
      for (const child of ids) {
        this.children.add(child)
        this.sink.event('agent.updated', {
          id: child,
          parentId: item.senderThreadId || this.threadId,
          model: item.model,
          ...object(states[child]),
          activity: item,
        })
      }
    }
    const kinds: Record<string, string> = {
      commandExecution: 'execute',
      fileChange: 'edit',
      mcpToolCall: 'other',
      webSearch: 'search',
      imageView: 'read',
      imageGeneration: 'other',
      collabAgentToolCall: 'other',
      subAgentActivity: 'other',
      plan: 'think',
    }
    if (!kinds[type]) {
      this.sink.event('provider.unknown', { method: 'item', item })
      return
    }
    const changes = array(item.changes)
    const imageData = string(item.result)
    const imageMime = imageData.startsWith('iVBORw0')
      ? 'image/png'
      : imageData.startsWith('/9j/')
        ? 'image/jpeg'
        : imageData.startsWith('UklGR')
          ? 'image/webp'
          : null
    this.put(id, {
      type: 'tool_call',
      id,
      title: string(item.command) || string(item.tool) || type,
      kind: kinds[type],
      status:
        item.status === 'failed'
          ? 'failed'
          : done
            ? 'completed'
            : 'in_progress',
      output: string(item.aggregatedOutput) || string(item.text) || undefined,
      raw_input: item,
      raw_output: done ? item : undefined,
      ...(type === 'imageGeneration' && done && imageMime
        ? {
            content: [
              {
                type: 'content',
                content: {
                  type: 'image',
                  mimeType: imageMime,
                  data: imageData,
                },
              },
            ],
          }
        : {}),
      ...(changes.length
        ? {
            locations: changes.map((c) => ({ path: c.path })),
            content: changes.map((c) => ({
              type: 'content',
              content: { type: 'text', text: string(c.diff) },
            })),
          }
        : {}),
    })
    // File changes are file events, not invented official artifacts.
    if (done && changes.length)
      this.sink.event('file_change.completed', { files: changes })
  }
  private async request(m: ObjectValue) {
    const method = string(m.method),
      p = object(m.params),
      id = String(m.id),
      controller = new AbortController()
    this.approvals.set(id, controller)
    try {
      let result: unknown
      if (
        method === 'item/tool/requestUserInput' ||
        method === 'tool/requestUserInput'
      ) {
        const questions = array(p.questions),
          response = object(
            await this.sink.request(
              'elicitation.request',
              questionForm(questions),
              controller.signal,
            ),
          )
        const answers = object(response.content)
        result = {
          answers: Object.fromEntries(
            questions.map((q, i) => {
              const key = string(q.id) || String(i),
                answer = answers[key]
              return [
                key,
                {
                  answers:
                    response.action === 'accept'
                      ? Array.isArray(answer)
                        ? answer
                        : [String(answer ?? '')]
                      : [],
                },
              ]
            }),
          ),
        }
      } else if (method === 'mcpServer/elicitation/request') {
        result = await this.sink.request(
          'elicitation.request',
          { ...p, mode: p.mode === 'openai/form' ? 'form' : p.mode },
          controller.signal,
        )
      } else if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      ) {
        const decisions = Array.isArray(p.availableDecisions)
          ? p.availableDecisions
          : ['accept', 'acceptForSession', 'decline', 'cancel']
        const response = object(
          await this.sink.request(
            'permission.request',
            {
              title: p.reason || p.command || 'Approve changes',
              tool_call: p,
              options: decisions.map((d, i) => ({
                id: String(i),
                label: typeof d === 'string' ? d : JSON.stringify(d),
                kind:
                  d === 'decline' || d === 'cancel'
                    ? 'reject_once'
                    : 'allow_once',
              })),
            },
            controller.signal,
          ),
        )
        const index = Number(response.option_id)
        result = {
          decision:
            response.option_id != null && Number.isInteger(index)
              ? (decisions[index] ?? 'cancel')
              : 'cancel',
        }
      } else if (method === 'item/permissions/requestApproval') {
        const response = object(
          await this.sink.request(
            'permission.request',
            {
              title: p.reason || 'Grant requested permissions',
              tool_call: p,
              options: [
                {
                  id: 'allow',
                  label: 'Allow for this message',
                  kind: 'allow_once',
                },
                { id: 'deny', label: 'Decline', kind: 'reject_once' },
              ],
            },
            controller.signal,
          ),
        )
        result = {
          permissions: response.option_id === 'allow' ? p.permissions : {},
          scope: 'turn',
        }
      } else {
        this.sink.event('provider.unknown', { method, params: p })
        this.rpc?.send({
          id: m.id,
          error: {
            code: -32601,
            message: `OpenYak has no handler for ${method}`,
          },
        })
        return
      }
      if (!controller.signal.aborted) this.rpc?.send({ id: m.id, result })
    } finally {
      this.approvals.delete(id)
    }
  }
  private abortRequests() {
    for (const c of this.approvals.values()) c.abort()
    this.approvals.clear()
  }
  async cancel() {
    this.cancelRequested = true
    this.abortRequests()
    if (this.turnId)
      await this.rpc?.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId,
      })
  }
  close() {
    this.abortRequests()
    this.rpc?.close()
  }
}
