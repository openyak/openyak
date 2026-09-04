import { randomUUID } from 'node:crypto'
import { claudeHostOptions } from '../agent-host-profiles.ts'
import {
  query,
  type Query,
  type SDKUserMessage,
  type Options,
  type ModelInfo,
  type PermissionMode,
} from '@anthropic-ai/claude-agent-sdk'
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

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private queued: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private ended = false
  push(message: SDKUserMessage) {
    this.queued.push(message)
    this.wake?.()
  }
  close() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      const next = this.queued.shift()
      if (next) yield next
      else
        await new Promise<void>((r) => {
          this.wake = r
        })
    }
  }
}
export class ClaudeDriver implements NativeDriver {
  private sdk: Query | null = null
  private input = new InputQueue()
  private sessionId = ''
  private values: ObjectValue = {}
  private models: ModelInfo[] = []
  private parts = new Map<string, Part>()
  private streamMessageId = ''
  private pending: {
    resolve: (v: ObjectValue) => void
    reject: (e: Error) => void
  } | null = null
  private cancelled = false
  private failure: Error | null = null
  private taskTools = new Map<string, string>()
  private taskKinds = new Map<string, string>()
  private sink: RuntimeSink
  constructor(sink: RuntimeSink) {
    this.sink = sink
  }
  async open(p: OpenParams) {
    this.sessionId = p.sessionId || randomUUID()
    this.values = p.config ?? {}
    const options: Options = {
      cwd: p.cwd,
      ...(p.sessionId
        ? { resume: p.sessionId }
        : { sessionId: this.sessionId }),
      systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: true },
      ...claudeHostOptions(),
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      forwardSubagentText: true,
      includeHookEvents: true,
      ...(process.env.OPENYAK_CLAUDE_BIN
        ? { pathToClaudeCodeExecutable: process.env.OPENYAK_CLAUDE_BIN }
        : {}),
      ...(this.values.model ? { model: string(this.values.model) } : {}),
      ...(this.values.mode
        ? { permissionMode: this.permissionMode(string(this.values.mode)) }
        : {}),
      ...(this.values.thought_level
        ? { effort: string(this.values.thought_level) as Options['effort'] }
        : {}),
      // Allows the user to choose bypass explicitly; does not enable it by default.
      allowDangerouslySkipPermissions: true,
      canUseTool: async (tool, input, context) => {
        if (tool === 'AskUserQuestion') {
          const response = object(
            await this.sink.request(
              'elicitation.request',
              questionForm(array(input.questions)),
              context.signal,
            ),
          )
          return response.action === 'accept'
            ? {
                behavior: 'allow',
                updatedInput: { ...input, answers: response.content },
              }
            : { behavior: 'deny', message: 'User cancelled the question' }
        }
        const response = object(
          await this.sink.request(
            'permission.request',
            {
              title: `Allow ${tool}?`,
              tool_call: { title: tool, rawInput: input },
              options: [
                { id: 'allow', label: 'Allow once', kind: 'allow_once' },
                { id: 'deny', label: 'Decline', kind: 'reject_once' },
              ],
            },
            context.signal,
          ),
        )
        return response.option_id === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User declined' }
      },
      onElicitation: async (request, context) => {
        const response = object(
          await this.sink.request(
            'elicitation.request',
            request,
            context.signal,
          ),
        )
        return {
          action:
            response.action === 'accept'
              ? 'accept'
              : response.action === 'decline'
                ? 'decline'
                : 'cancel',
          ...(response.content
            ? {
                content: response.content as Record<
                  string,
                  string | number | boolean | string[]
                >,
              }
            : {}),
        }
      },
      stderr: (data) => process.stderr.write(data),
    }
    this.sdk = query({ prompt: this.input, options })
    void this.consume()
    const init = await this.sdk.initializationResult()
    this.models = init.models
    this.values.model ??= this.models[0]?.value
    this.sink.event('session.capabilities', {
      transport: 'claude-agent-sdk',
      commands: init.commands,
      agents: init.agents,
      models: init.models,
    })
    this.sink.event('available_commands_update', {
      availableCommands: init.commands,
    })
    this.emitConfig()
    return { sessionId: this.sessionId }
  }
  private permissionMode(value: string): PermissionMode {
    const aliases: Record<string, PermissionMode> = {
      'accept-edits': 'acceptEdits',
      'bypass-permissions': 'bypassPermissions',
      'full-access': 'bypassPermissions',
      'read-only': 'plan',
    }
    const mode = aliases[value] || value
    if (
      ![
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'dontAsk',
        'auto',
      ].includes(mode)
    )
      throw new Error('Unsupported Claude permission mode')
    return mode as PermissionMode
  }
  private emitConfig() {
    const model = this.models.find(
      (m) =>
        m.value === this.values.model || m.resolvedModel === this.values.model,
    )
    this.sink.config([
      selectOption(
        'model',
        'Model',
        'model',
        model?.value || string(this.values.model),
        this.models.map((m) => ({ value: m.value, name: m.displayName })),
      ),
      ...(model?.supportedEffortLevels?.length
        ? [
            selectOption(
              'thought_level',
              'Reasoning',
              'thought_level',
              string(this.values.thought_level) || 'high',
              model.supportedEffortLevels.map((e) => ({ value: e, name: e })),
            ),
          ]
        : []),
      selectOption(
        'mode',
        'Permissions',
        'mode',
        string(this.values.mode) || 'default',
        [
          { value: 'default', name: 'Ask for approval' },
          { value: 'acceptEdits', name: 'Accept edits' },
          { value: 'plan', name: 'Plan' },
          { value: 'bypassPermissions', name: 'Bypass permissions' },
        ],
      ),
    ])
  }
  async configure(id: string, value: unknown) {
    if (this.pending) throw new Error('Message is running')
    if (id === 'model') {
      if (!this.models.some((m) => m.value === value))
        throw new Error('Unknown Claude model')
      await this.sdk!.setModel(string(value))
    } else if (id === 'mode')
      await this.sdk!.setPermissionMode(this.permissionMode(string(value)))
    else if (id === 'thought_level') {
      const model = this.models.find(
        (m) =>
          m.value === this.values.model ||
          m.resolvedModel === this.values.model,
      )
      if (!model?.supportedEffortLevels?.includes(value as never))
        throw new Error('Unsupported reasoning effort')
      await this.sdk!.applyFlagSettings({
        effortLevel: value as Options['effort'],
      })
    } else throw new Error('Unsupported setting')
    this.values[id] = value
    this.emitConfig()
  }
  async prompt(blocks: ObjectValue[]): Promise<ObjectValue> {
    if (this.failure) throw this.failure
    if (this.pending) throw new Error('A message is already running')
    this.parts.clear()
    this.cancelled = false
    this.streamMessageId = ''
    const content = blocks.flatMap<ObjectValue>((b) =>
      b.type === 'text'
        ? [{ type: 'text', text: b.text }]
        : b.type === 'image'
          ? [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: b.mimeType,
                  data: b.data,
                },
              },
            ]
          : b.type === 'resource_link'
            ? [{ type: 'text', text: `Attached file: ${b.uri}` }]
            : [],
    )
    const completion = new Promise<ObjectValue>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
    this.input.push({
      type: 'user',
      uuid: randomUUID(),
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: content as unknown as SDKUserMessage['message']['content'],
      },
    })
    return completion
  }
  private put(key: string, part: Part) {
    this.parts.set(key, part)
    this.sink.part(key, part)
  }
  private async consume() {
    try {
      for await (const value of this.sdk!) {
        const m = object(value),
          parent = string(m.parent_tool_use_id)
        this.sink.event('provider.raw', m, string(m.session_id))
        if (parent) {
          this.sink.event('agent.updated', {
            id: parent,
            parentId: this.sessionId,
            status: 'running',
            activity: m,
          })
          continue
        }
        if (m.type === 'system') {
          if (m.subtype === 'init') {
            this.sessionId = string(m.session_id) || this.sessionId
            if (!this.values.model && typeof m.model === 'string')
              this.values.model = m.model
            this.values.mode ??= m.permissionMode
            this.sink.event('session.capabilities', m)
            this.emitConfig()
          }
          if (
            string(m.subtype).startsWith('task_') &&
            !m.ambient &&
            !m.skip_transcript
          ) {
            const patch = object(m.patch)
            if (m.task_id && m.tool_use_id)
              this.taskTools.set(string(m.task_id), string(m.tool_use_id))
            const toolId =
              string(m.tool_use_id) ||
              this.taskTools.get(string(m.task_id)) ||
              ''
            const tool = this.parts.get(toolId)
            if (m.task_type)
              this.taskKinds.set(string(m.task_id), string(m.task_type))
            const isAgent =
              this.taskKinds.get(string(m.task_id)) === 'local_agent' ||
              (tool?.type === 'tool_call' &&
                ['Agent', 'Task'].includes(tool.title))
            this.sink.event(isAgent ? 'agent.updated' : 'task.updated', {
              ...m,
              id:
                m.tool_use_id ||
                this.taskTools.get(string(m.task_id)) ||
                m.task_id,
              parentId: this.sessionId,
              name: m.description || patch.description,
              status: m.status || patch.status || 'running',
              activity: m,
            })
          }
          if (m.subtype === 'commands_changed')
            this.sink.event('available_commands_update', {
              availableCommands: m.commands,
            })
        }
        if (m.type === 'stream_event') this.stream(object(m.event))
        if (m.type === 'assistant') this.assistant(m)
        if (m.type === 'user') {
          for (const block of array(object(m.message).content))
            if (block.type === 'tool_result') {
              const id = string(block.tool_use_id),
                part = this.parts.get(id)
              if (part?.type === 'tool_call')
                this.put(id, {
                  ...part,
                  status: block.is_error ? 'failed' : 'completed',
                  output:
                    typeof block.content === 'string'
                      ? block.content
                      : array(block.content)
                          .map((b) => string(b.text))
                          .join('\n'),
                  raw_output: m.tool_use_result ?? block.content,
                  ...(Array.isArray(block.content)
                    ? {
                        content: block.content.map((content) => ({
                          type: 'content',
                          content,
                        })),
                      }
                    : {}),
                })
              if (
                part?.type === 'tool_call' &&
                ['Agent', 'Task'].includes(part.title) &&
                object(part.raw_input).run_in_background !== true
              )
                this.sink.event('agent.updated', {
                  id,
                  parentId: this.sessionId,
                  status: block.is_error ? 'failed' : 'completed',
                })
            }
          this.sink.event('_claude/sdkMessage', { message: m })
        }
        if (m.type === 'result') {
          this.sink.event('usage.updated', {
            usage: m.usage,
            modelUsage: m.modelUsage,
            cost: m.total_cost_usd,
          })
          if (m.is_error && !this.cancelled)
            this.pending?.reject(
              new Error(
                Array.isArray(m.errors)
                  ? m.errors.join('\n')
                  : string(m.result) || string(m.subtype),
              ),
            )
          else
            this.pending?.resolve({
              stopReason: this.cancelled ? 'cancelled' : 'end_turn',
              _meta: { usage: m.usage, modelUsage: m.modelUsage },
            })
          this.pending = null
        }
      }
      throw new Error('Claude runtime stream closed')
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.pending?.reject(this.failure)
      this.pending = null
    }
  }
  private stream(event: ObjectValue) {
    if (event.type === 'message_start')
      this.streamMessageId = string(object(event.message).id)
    const key = `${this.streamMessageId}:${event.index}`
    if (event.type === 'content_block_start') {
      const b = object(event.content_block)
      if (b.type === 'text' || b.type === 'thinking')
        this.put(key, {
          type: b.type === 'text' ? 'text' : 'thought',
          text: string(b.text || b.thinking),
          message_id: this.streamMessageId,
        })
    }
    if (event.type === 'content_block_delta') {
      const delta = object(event.delta),
        part = this.parts.get(key)
      if (
        (part?.type === 'text' || part?.type === 'thought') &&
        (delta.type === 'text_delta' || delta.type === 'thinking_delta')
      )
        this.put(key, {
          ...part,
          text: part.text + string(delta.text || delta.thinking),
        })
    }
  }
  private assistant(m: ObjectValue) {
    const message = object(m.message),
      id = string(message.id) || string(m.uuid)
    array(message.content).forEach((block, index) => {
      if (block.type === 'text' || block.type === 'thinking')
        this.put(`${id}:${index}`, {
          type: block.type === 'text' ? 'text' : 'thought',
          text: string(block.text || block.thinking),
          message_id: id,
        })
      if (block.type === 'tool_use') {
        const toolId = string(block.id),
          name = string(block.name)
        const kinds: Record<string, string> = {
          Bash: 'execute',
          Read: 'read',
          Write: 'edit',
          Edit: 'edit',
          Glob: 'search',
          Grep: 'search',
          WebSearch: 'search',
          WebFetch: 'fetch',
        }
        this.put(toolId, {
          type: 'tool_call',
          id: toolId,
          title: name,
          kind: kinds[name] || 'other',
          status: 'in_progress',
          raw_input: block.input,
          _meta: { claudeCode: { toolName: name } },
        })
        if (name === 'Agent' || name === 'Task')
          this.sink.event('agent.updated', {
            id: toolId,
            parentId: this.sessionId,
            name: object(block.input).description,
            status: 'running',
          })
      }
    })
  }
  async cancel() {
    this.cancelled = true
    await this.sdk?.interrupt()
  }
  close() {
    this.input.close()
    this.sdk?.close()
  }
}
