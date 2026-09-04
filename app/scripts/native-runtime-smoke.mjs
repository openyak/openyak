// Explicit opt-in live integration check: uses the user's configured local runtime.
// npm run build -w app && node app/scripts/native-runtime-smoke.mjs codex
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import process from 'node:process'
import console from 'node:console'
import { URL } from 'node:url'
import { setTimeout, clearTimeout } from 'node:timers'

const provider = process.argv[2] || 'codex'
const cwd = await mkdtemp(join(tmpdir(), 'openyak-native-smoke-'))
const worker = fileURLToPath(
  new URL('../out/main/runtime-worker.js', import.meta.url),
)
const child = spawn(process.execPath, [worker, provider], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, CLAUDECODE: '' },
})
const pending = new Map()
let id = 0,
  raw = 0,
  latest = new Map(),
  sessionId = ''
const write = (value) => child.stdin.write(`${JSON.stringify(value)}\n`)
createInterface({ input: child.stdout }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method) {
    if (m.id) {
      write({ id: m.id, result: { action: 'cancel', option_id: null } })
      return
    }
    if (m.method === 'runtime.part') latest.set(m.params.key, m.params.part)
    if (m.method === 'runtime.event' && m.params.type === 'provider.raw') raw++
    if (m.method === 'runtime.config')
      console.log(
        'config',
        m.params.options.map((o) => `${o.id}=${o.currentValue}`).join(', '),
      )
  } else {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message))
    else p.resolve(m.result)
  }
})
child.on('exit', (code) => {
  for (const p of pending.values()) p.reject(new Error(`worker exited ${code}`))
  pending.clear()
})
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const key = String(++id)
    pending.set(key, { resolve, reject })
    write({ id: key, method, params })
  })
const timeout = setTimeout(() => {
  console.error('Smoke timed out')
  child.kill('SIGTERM')
  process.exitCode = 1
}, 150_000)
try {
  const opened = await request('session.open', { cwd, config: {} })
  sessionId = opened.sessionId
  assert.ok(sessionId)
  const result = await request('turn.start', {
    input: [
      {
        type: 'text',
        text: 'Reply with exactly: native-runtime-ok. Do not use tools or modify files.',
      },
    ],
  })
  assert.equal(result.stopReason, 'end_turn')
  const output = [...latest.values()]
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  assert.match(output, /native-runtime-ok/)
  assert.ok(raw > 0)
  console.log(
    JSON.stringify({
      provider,
      sessionId,
      rawEvents: raw,
      text: output,
      stopReason: result.stopReason,
    }),
  )
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  child.stdin.end()
  setTimeout(() => child.kill('SIGTERM'), 3000).unref()
  await rm(cwd, { recursive: true, force: true })
}
