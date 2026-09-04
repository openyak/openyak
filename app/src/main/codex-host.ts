import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

type RequestId = number

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface JsonRpcMessage {
  id?: RequestId
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
}

/**
 * Thin client for the public Codex App Server protocol. ACP remains the conversation
 * transport; this connection supplies stable desktop-host inventory APIs that ACP
 * intentionally does not expose.
 */
export class CodexHostClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<RequestId, PendingRequest>()
  private ready: Promise<void> | null = null

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const codexBin = nodeRequire.resolve('@openai/codex/bin/codex.js')
      const child = spawn(process.execPath, [codexBin, 'app-server'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      createInterface({ input: child.stdout }).on('line', (line) => this.receive(line))
      child.stderr.on('data', (chunk) => {
        if (process.env.NODE_ENV !== 'production') {
          console.error(`[codex app-server] ${String(chunk).trimEnd()}`)
        }
      })
      child.once('error', (error) => {
        this.failAll(error)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        const error = new Error(`Codex App Server exited (code ${code ?? '-'}, signal ${signal ?? '-'})`)
        this.failAll(error)
        this.child = null
        this.ready = null
      })
      this.send('initialize', {
        clientInfo: { name: 'openyak', title: 'OpenYak', version: '2.0.0-alpha.0' },
        capabilities: { requestAttestation: false },
      })
        .then(() => resolve())
        .catch((error) => {
          reject(error)
          child.kill()
        })
    })
    return this.ready
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    await this.start()
    return (await this.send(method, params)) as T
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child?.stdin.writable) return Promise.reject(new Error('Codex App Server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server timed out while calling ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  private receive(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }
    if (message.id == null) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex App Server error ${message.error.code ?? ''}`))
    } else {
      pending.resolve(message.result)
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  kill(): void {
    this.child?.kill()
    this.child = null
    this.ready = null
  }
}
