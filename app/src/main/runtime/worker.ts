import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { CodexDriver } from './codex'
import { ClaudeDriver } from './claude'
import {
  array,
  object,
  string,
  type RuntimeSink,
  type OpenParams,
} from './protocol'

const provider = process.argv[2]
if (provider !== 'codex' && provider !== 'claude')
  throw new Error('Unknown native runtime')
const epoch = randomUUID()
// Never pass the host-wide registration secret into agent subprocesses/tools.
const browserHostOrigin = process.env.OPENYAK_BROWSER_HOST
const browserHostSecret = process.env.OPENYAK_BROWSER_SECRET
delete process.env.OPENYAK_BROWSER_HOST
delete process.env.OPENYAK_BROWSER_SECRET
let sequence = 0
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; cleanup: () => void }
>()
const send = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
const sink: RuntimeSink = {
  part: (key, part) => send({ method: 'runtime.part', params: { key, part } }),
  event: (type, data, sourceSessionId) =>
    send({
      method: 'runtime.event',
      params: {
        schemaVersion: 1,
        type,
        data,
        provider,
        epoch,
        sequence: ++sequence,
        sourceSessionId,
      },
    }),
  config: (options) => send({ method: 'runtime.config', params: { options } }),
  request: (method, params, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ action: 'cancel', option_id: null })
        return
      }
      const id = randomUUID()
      const abort = () => {
        pending.delete(id)
        signal?.removeEventListener('abort', abort)
        send({ method: 'runtime.request.cancelled', params: { id } })
        resolve({ action: 'cancel', option_id: null })
      }
      pending.set(id, {
        resolve,
        cleanup: () => signal?.removeEventListener('abort', abort),
      })
      signal?.addEventListener('abort', abort, { once: true })
      send({ id, method, params })
    }),
}
const driver =
  provider === 'codex' ? new CodexDriver(sink) : new ClaudeDriver(sink)
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let m: Record<string, unknown>
  try {
    m = object(JSON.parse(line))
  } catch {
    return
  }
  if (!m.method) {
    const p = pending.get(string(m.id))
    if (p) {
      pending.delete(string(m.id))
      p.cleanup()
      p.resolve(m.result ?? { action: 'cancel', option_id: null })
    }
    return
  }
  const run = async () => {
    const p = object(m.params)
    switch (m.method) {
      case 'session.open': {
        const host = browserHostOrigin
        if (host && p.taskId) {
          const response = await fetch(`${host}/session`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${browserHostSecret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: p.taskId, cwd: p.cwd }),
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) throw new Error('Cannot connect the task browser host')
          p.browserMcpUrl = object(await response.json()).url
        }
        return driver.open(p as unknown as OpenParams)
      }
      case 'session.configure':
        await driver.configure(string(p.id), p.value)
        return {}
      case 'turn.start':
        return driver.prompt(array(p.input))
      case 'turn.cancel':
        await driver.cancel()
        return {}
      default:
        throw new Error(`Unknown runtime method: ${String(m.method)}`)
    }
  }
  void run()
    .then((result) => {
      if (m.id !== undefined) send({ id: m.id, result })
    })
    .catch((error) => {
      if (m.id !== undefined)
        send({
          id: m.id,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      else sink.event('runtime.error', { message: String(error) })
    })
})
let closing = false
function close() {
  if (closing) return
  closing = true
  driver.close()
  for (const p of pending.values()) {
    p.cleanup()
    p.resolve({ action: 'cancel', option_id: null })
  }
  pending.clear()
  setTimeout(() => process.exit(0), 2000).unref()
}
lines.on('close', close)
process.on('SIGTERM', close)
process.on('SIGINT', close)
