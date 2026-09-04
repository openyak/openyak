import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonRpcProcess } from '../src/main/runtime/json-rpc.ts'
import { CodexDriver } from '../src/main/runtime/codex.ts'
import { ClaudeDriver } from '../src/main/runtime/claude.ts'
import { childAgents } from '../src/renderer/src/runtimePresentation.ts'
import { questionForm, type RuntimeSink } from '../src/main/runtime/protocol.ts'
import type { Part } from '../src/shared/protocol.ts'

function harness() {
  const parts = new Map<string, Part>(),
    events: { type: string; data: unknown }[] = [],
    requests: unknown[] = []
  const sink: RuntimeSink = {
    part: (k, p) => parts.set(k, p),
    event: (type, data) => events.push({ type, data }),
    config: () => {},
    request: async (m, p) => {
      requests.push({ m, p })
      return {
        action: 'accept',
        content: { q: 'Custom answer' },
        option_id: '0',
      }
    },
  }
  return { parts, events, requests, sink }
}
test('full duplex RPC dispatches server requests even when their IDs collide with client requests', async () => {
  const received: unknown[] = []
  const source = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method){console.log(JSON.stringify({id:m.id,method:'approval',params:{}}));console.log(JSON.stringify({method:'progress',params:{}}));console.log(JSON.stringify({id:m.id,result:{ok:true}}))}})`
  const rpc = new JsonRpcProcess(
    process.execPath,
    ['-e', source],
    (m) => received.push(m),
    () => {},
  )
  try {
    assert.deepEqual(await rpc.request('go'), { ok: true })
    assert.equal(received.length, 2)
  } finally {
    rpc.close()
  }
})
test('Codex reconciles streaming text with authoritative completion and preserves phase', () => {
  const h = harness(),
    driver = new CodexDriver(h.sink)
  const receive = (
    driver as unknown as { receive: (m: unknown) => void }
  ).receive.bind(driver)
  receive({
    method: 'item/started',
    params: {
      item: { id: 'a', type: 'agentMessage', text: '', phase: 'commentary' },
    },
  })
  receive({
    method: 'item/agentMessage/delta',
    params: { itemId: 'a', delta: 'Partial' },
  })
  receive({
    method: 'item/completed',
    params: {
      item: {
        id: 'a',
        type: 'agentMessage',
        text: 'Final',
        phase: 'final_answer',
      },
    },
  })
  assert.equal(h.parts.size, 1)
  assert.deepEqual(h.parts.get('a'), {
    type: 'text',
    text: 'Final',
    message_id: 'a',
    _meta: { codex: { phase: 'final_answer' } },
  })
  assert.equal(h.events.filter((e) => e.type === 'provider.raw').length, 3)
  receive({
    method: 'item/completed',
    params: { item: { id: 'new', type: 'futureProviderItem', value: 42 } },
  })
  assert.ok(h.events.some((e) => e.type === 'provider.unknown'))
})
test('Codex collaboration counts actual child threads, not the spawn/wait tool calls', () => {
  const h = harness(),
    driver = new CodexDriver(h.sink)
  const d = driver as unknown as { receive(m: unknown): void }
  d.receive({
    method: 'item/completed',
    params: {
      item: {
        id: 'spawn-call',
        type: 'collabAgentToolCall',
        senderThreadId: 'root',
        receiverThreadIds: ['child'],
        agentsStates: { child: { status: 'running', message: null } },
      },
    },
  })
  d.receive({
    method: 'item/completed',
    params: {
      item: {
        id: 'wait-call',
        type: 'collabAgentToolCall',
        senderThreadId: 'root',
        receiverThreadIds: ['child'],
        agentsStates: { child: { status: 'completed', message: 'Done' } },
      },
    },
  })
  const children = childAgents(
    h.events.map((e) => ({ type: 'event', kind: e.type, data: e.data })),
  )
  assert.equal(children.length, 1)
  assert.equal(children[0].id, 'child')
  assert.equal(children[0].status, 'completed')
})
test('Codex requestUserInput replies use the official answer map', async () => {
  const h = harness(),
    driver = new CodexDriver(h.sink),
    replies: unknown[] = []
  const d = driver as unknown as {
    rpc: { send(m: unknown): void }
    request(m: unknown): Promise<void>
  }
  d.rpc = { send: (m) => replies.push(m) }
  await d.request({
    id: 9,
    method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'q', question: 'Choose' }] },
  })
  assert.deepEqual(replies, [
    { id: 9, result: { answers: { q: { answers: ['Custom answer'] } } } },
  ])
})
test('Codex approvals join pending file details and preserve every decision on reply', async () => {
  const decisions = ['accept', 'acceptForSession', 'decline', 'cancel', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pnpm', 'test'] } }]
  for (const [index, decision] of decisions.entries()) {
    const h = harness(), replies: unknown[] = []
    let payload: Record<string, unknown> = {}
    h.sink.request = async (_method, params) => { payload = params as Record<string, unknown>; return { option_id: String(index) } }
    const driver = new CodexDriver(h.sink)
    const d = driver as unknown as { rpc: { send(m: unknown): void }; receive(m: unknown): void; request(m: unknown): Promise<void> }
    d.rpc = { send: m => replies.push(m) }
    d.receive({ method: 'item/started', params: { item: { id: 'change', type: 'fileChange', changes: [{ path: '/project/report.md', diff: '+# Report' }] } } })
    await d.request({ id: 40, method: 'item/fileChange/requestApproval', params: { itemId: 'change', availableDecisions: decisions } })
    assert.deepEqual(replies, [{ id: 40, result: { decision } }])
    assert.equal(payload.title, 'Allow changes to report.md?')
    assert.deepEqual((payload.details as { files: unknown }).files, [{ path: '/project/report.md', diff: '+# Report' }])
  }
})
test('Codex invalid or unsupported approval responses fail closed', async () => {
  for (const option_id of [null, '', ' ', '-1', '999', '0.0', '0']) {
    const h = harness(), replies: unknown[] = []
    h.sink.request = async () => ({ option_id })
    const d = new CodexDriver(h.sink) as unknown as { rpc: { send(m: unknown): void }; request(m: unknown): Promise<void> }
    d.rpc = { send: m => replies.push(m) }
    await d.request({ id: 41, method: 'item/commandExecution/requestApproval', params: { availableDecisions: [{ futureGrant: {} }] } })
    assert.deepEqual(replies, [{ id: 41, result: { decision: 'cancel' } }])
  }
})
test('unknown native requests fail explicitly, never fabricate successful results', async () => {
  const h = harness(),
    driver = new CodexDriver(h.sink),
    replies: unknown[] = []
  const d = driver as unknown as {
    rpc: { send(m: unknown): void }
    request(m: unknown): Promise<void>
  }
  d.rpc = { send: (m) => replies.push(m) }
  await d.request({ id: 9, method: 'future/tool', params: {} })
  assert.equal((replies[0] as { error: { code: number } }).error.code, -32601)
  assert.ok(h.events.some((e) => e.type === 'provider.unknown'))
})
test('provider process exit rejects subsequent requests instead of hanging', async () => {
  let finish!: () => void
  const exited = new Promise<void>((resolve) => {
    finish = resolve
  })
  const rpc = new JsonRpcProcess(
    process.execPath,
    ['-e', 'process.exit(7)'],
    () => {},
    () => finish(),
  )
  await exited
  await assert.rejects(rpc.request('next'), /Provider exited/)
  rpc.close()
})
test('Claude background shell tasks are not counted as child Agents', async () => {
  const h = harness(),
    driver = new ClaudeDriver(h.sink)
  const d = driver as unknown as {
    sdk: AsyncIterable<unknown>
    consume(): Promise<void>
  }
  d.sdk = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 'bash',
        task_type: 'local_bash',
        description: 'Build',
      }
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent',
        task_type: 'local_agent',
        tool_use_id: 'tool',
        description: 'Review',
      }
      yield {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'agent',
        patch: { status: 'completed' },
      }
    },
  }
  await d.consume()
  assert.ok(h.events.some((e) => e.type === 'task.updated'))
  const children = childAgents(
    h.events.map((e) => ({ type: 'event', kind: e.type, data: e.data })),
  )
  assert.equal(children.length, 1)
  assert.equal(children[0].id, 'tool')
  assert.equal(children[0].status, 'completed')
})
test('Claude partial and completed messages share part identities; tool outputs stay structured', () => {
  const h = harness(),
    driver = new ClaudeDriver(h.sink)
  const d = driver as unknown as {
    stream: (m: unknown) => void
    assistant: (m: unknown) => void
  }
  d.stream({ type: 'message_start', message: { id: 'msg' } })
  d.stream({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })
  d.stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  })
  d.assistant({
    type: 'assistant',
    message: {
      id: 'msg',
      content: [
        { type: 'text', text: 'Hello there' },
        {
          type: 'tool_use',
          id: 'tool',
          name: 'Artifact',
          input: { action: 'publish' },
        },
      ],
    },
  })
  assert.equal(h.parts.size, 2)
  assert.equal((h.parts.get('msg:0') as { text: string }).text, 'Hello there')
  const tool = h.parts.get('tool') as Extract<Part, { type: 'tool_call' }>
  assert.deepEqual(tool._meta, { claudeCode: { toolName: 'Artifact' } })
  assert.deepEqual(tool.raw_input, { action: 'publish' })
})
test('questions preserve provider IDs, choices, descriptions and multi-select constraints', () => {
  const form = questionForm([
    {
      id: 'q',
      question: 'Choose',
      options: [{ label: 'A', description: 'First' }],
    },
    {
      question: 'Languages',
      multiSelect: true,
      options: [{ label: 'Rust' }, { label: 'TS' }],
    },
  ])
  assert.deepEqual(form.requestedSchema.required, ['q', 'Languages'])
  assert.match(form.requestedSchema.properties.q.description, /A: First/)
  assert.equal(form.requestedSchema.properties.Languages.type, 'array')
})
test('subagent status updates preserve history and never create duplicate cards', () => {
  const agents = childAgents([
    {
      type: 'event',
      kind: 'agent.updated',
      data: {
        id: 'child',
        name: 'Research',
        parentId: 'root',
        status: 'running',
        activity: { text: 'a' },
      },
    },
    {
      type: 'event',
      kind: 'agent.updated',
      data: { id: 'child', status: 'completed' },
    },
    {
      type: 'event',
      kind: 'other',
      data: { id: 'invented', status: 'running' },
    },
  ])
  assert.deepEqual(agents, [
    {
      id: 'child',
      name: 'Research',
      parentId: 'root',
      status: 'completed',
      model: undefined,
      activities: [{ text: 'a' }],
    },
  ])
})
