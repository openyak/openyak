// Deterministic Core/worker integration, or opt-in live provider check.
// cargo build --manifest-path core/Cargo.toml && npm run build -w app
// node app/scripts/native-core-smoke.mjs [fake|codex|claude]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { once } from 'node:events'
import { setTimeout, clearTimeout } from 'node:timers'
import process from 'node:process'
import console from 'node:console'

const mode = process.argv[2] || 'fake'
const agent = mode === 'claude' ? 'claude' : 'codex'
const directory = await mkdtemp(join(tmpdir(), 'openyak-core-smoke-'))
const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let active, answers = new Set(), session, holding = false;
const send = v => console.log(JSON.stringify(v));
const event = (type,data) => send({method:'runtime.event',params:{schemaVersion:1,type,data,provider:'fixture',epoch:'test',sequence:1}});
const done = stopReason => { send({id:active,result:{stopReason}}); active=undefined; };
rl.on('line', line => {
 const m=JSON.parse(line), p=m.params||{};
 if (m.method==='session.open') { session=p.sessionId||'fixture-session'; event('fixture.open',{resumed:!!p.sessionId,session}); send({id:m.id,result:{sessionId:session}}); }
 else if(m.method==='turn.start') {
   active=m.id; const text=p.input.map(b=>b.text||'').join(' ');
   event('provider.raw',{input:p.input});
   if(text.endsWith('crash')) return process.exit(7);
   if(text.endsWith('hold')) { holding=true; event('fixture.holding',{}); return; }
   for(const id of ['question-a','question-b']) send({id,method:'elicitation.request',params:{mode:'form',message:id,requestedSchema:{type:'object',properties:{q:{type:'string'}}}}});
 } else if(!m.method && m.id.startsWith('question-')) {
   answers.add(m.id); if(answers.size===2) {
     send({method:'runtime.part',params:{key:'answer',part:{type:'text',text:'core-native-ok'}}});
     event('agent.updated',{id:'child',parentId:session,status:'completed',name:'Fixture child'});
     done('end_turn'); answers.clear();
   }
 } else if(m.method==='turn.cancel' && holding) { holding=false; done('cancelled'); }
});
rl.on('close',()=>process.exit(0));
`
const spec = {
  command: process.execPath,
  args:
    mode === 'fake'
      ? ['-e', fixture]
      : [join(root, 'app/out/main/runtime-worker.js'), agent],
  env: { CLAUDECODE: '' },
}
let child,
  counter = 0,
  notifications = [],
  requests = [],
  pending = new Map()
function start() {
  notifications = []
  child = spawn(
    join(root, 'core/target/debug/openyak-core'),
    ['--data-dir', directory, '--runtimes', JSON.stringify({ [agent]: spec })],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.method) {
      notifications.push(m)
      if (m.id !== undefined) {
        requests.push(m)
        write({
          id: m.id,
          result: {
            action: 'accept',
            content: { q: 'test answer' },
            option_id: null,
          },
        })
      }
    } else {
      const p = pending.get(m.id)
      if (p) {
        pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.error) p.reject(new Error(m.error.message))
        else p.resolve(m.result)
      }
    }
  })
  child.once('exit', () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('Core exited'))
    }
    pending.clear()
  })
}
const write = (value) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++counter,
      timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 150_000)
    pending.set(id, { resolve, reject, timer })
    write({ id, method, params })
  })
async function until(predicate) {
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    const value = notifications.find(predicate)
    if (value) return value
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('Expected notification not received')
}
async function stop() {
  const stopped = once(child, 'exit')
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGTERM'), 6000)
  await stopped
  clearTimeout(timer)
}
let running = false
try {
  start()
  running = true
  const task = await request('task.create', {
    title: 'Native integration test',
  })
  const args = { task_id: task.id, agent }
  const send = async (text) => {
    const sent = await request('chat.send', { ...args, text })
    const done = await until(
      (m) =>
        m.method === 'chat.done' &&
        m.params.message_id === sent.assistant_message_id,
    )
    assert.equal(done.params.status, 'done', JSON.stringify(done.params))
    return sent
  }
  await send(
    mode === 'fake'
      ? 'first'
      : 'Reply with exactly: core-native-ok. Do not use tools or modify files.',
  )
  let history = await request('chat.history', { task_id: task.id })
  assert.equal(history.length, 2)
  assert.ok(
    history[1].parts.some(
      (p) => p.type === 'text' && p.text.includes('core-native-ok'),
    ),
  )
  const raw = await request('runtime.events', { task_id: task.id, limit: 1 })
  assert.equal(raw.events.length, 1)
  assert.ok(raw.next_cursor > 0)
  assert.ok(
    (await request('chat.events', { task_id: task.id })).every(
      (e) => e.kind !== 'provider.raw',
    ),
  )
  if (mode === 'fake') {
    assert.equal(requests.length, 2)
    assert.notEqual(requests[0].id, requests[1].id)
  }
  await stop()
  running = false
  start()
  running = true
  await send(
    mode === 'fake'
      ? 'second'
      : 'Reply with exactly: core-native-ok. Do not use tools or modify files.',
  )
  history = await request('chat.history', { task_id: task.id })
  assert.equal(history.length, 4)
  if (mode === 'fake') {
    const events = await request('chat.events', { task_id: task.id })
    assert.ok(
      events.some((e) => e.kind === 'fixture.open' && e.data.resumed === true),
    )
    const next = await request('runtime.events', {
      task_id: task.id,
      after: raw.next_cursor,
    })
    assert.equal(
      next.events[0].data.input[0].text,
      'second',
      'resumed cursor must not replay previous messages',
    )
    const held = await request('chat.send', { ...args, text: 'hold' })
    await until(
      (m) =>
        m.method === 'chat.update' && m.params.part?.kind === 'fixture.holding',
    )
    await request('chat.cancel', { task_id: task.id })
    const cancelled = await until(
      (m) =>
        m.method === 'chat.done' &&
        m.params.message_id === held.assistant_message_id,
    )
    assert.equal(cancelled.params.status, 'cancelled')
    const crashed = await request('chat.send', { ...args, text: 'crash' })
    const failed = await until(
      (m) =>
        m.method === 'chat.done' &&
        m.params.message_id === crashed.assistant_message_id,
    )
    assert.equal(failed.params.status, 'error')
  }
  console.log(
    JSON.stringify({
      mode,
      passed: true,
      historyMessages: history.length,
      checks: [
        'send',
        'raw pagination',
        'restart',
        'resume',
        ...(mode === 'fake'
          ? ['concurrent questions', 'cursor isolation', 'cancel', 'crash']
          : []),
      ],
    }),
  )
} finally {
  if (running) await stop()
  await rm(directory, { recursive: true, force: true })
}
