import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

type JsonRpcId = number | string

interface JsonRpcMessage {
  jsonrpc?: '2.0'
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export class CoreError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message)
    this.name = 'CoreError'
  }
}

/**
 * NDJSON JSON-RPC 2.0 client over a child process's stdin/stdout.
 *
 * Events:
 *   'notification' (method, params)        — core → app notification
 *   'request'      (id, method, params)    — core → app request; answer with respond()
 *   'exit'         (code, signal)          — core process ended
 */
export class CoreClient extends EventEmitter {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<JsonRpcId, Pending>()
  private exited = false

  constructor(binary: string, args: string[]) {
    super()
    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    this.child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[core] ${chunk.toString()}`)
    })

    const lines = createInterface({ input: this.child.stdout! })
    lines.on('line', (line) => this.onLine(line))

    this.child.on('error', (err) => {
      process.stderr.write(`[core] spawn error: ${err.message}\n`)
    })
    this.child.on('close', (code, signal) => {
      this.exited = true
      const err = new Error(`core exited (code ${code}, signal ${signal})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.emit('exit', code, signal)
    })
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('core is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  kill(): void {
    if (!this.exited) this.child.kill()
  }

  private write(msg: JsonRpcMessage): void {
    if (this.exited || !this.child.stdin?.writable) return
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      process.stderr.write(`[core] non-JSON stdout line: ${line}\n`)
      return
    }
    if (typeof msg !== 'object' || msg === null) return

    if (msg.method !== undefined) {
      if (msg.id === undefined || msg.id === null) {
        this.emit('notification', msg.method, msg.params)
      } else {
        this.emit('request', msg.id, msg.method, msg.params)
      }
      return
    }

    if (msg.id === undefined || msg.id === null) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new CoreError(msg.error.code, msg.error.message, msg.error.data))
    else p.resolve(msg.result)
  }
}
