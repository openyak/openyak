import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { object, string, type ObjectValue } from './protocol.ts'

/** Full-duplex provider transport. Method-bearing messages are never RPC responses. */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams
  private counter = 0
  private pending = new Map<
    number,
    {
      resolve: (v: ObjectValue) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private failure: Error | null = null
  private receive: (message: ObjectValue) => void
  private onExit: (error: Error) => void
  constructor(
    command: string,
    args: string[],
    receive: (message: ObjectValue) => void,
    onExit: (error: Error) => void,
  ) {
    this.receive = receive
    this.onExit = onExit
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: ObjectValue
      try {
        message = object(JSON.parse(line))
      } catch {
        return
      }
      if (typeof message.method === 'string') {
        this.receive(message)
        return
      }
      const pending = this.pending.get(message.id as number)
      if (!pending) return
      this.pending.delete(message.id as number)
      clearTimeout(pending.timer)
      if (message.error)
        pending.reject(
          new Error(
            string(object(message.error).message) || 'Provider request failed',
          ),
        )
      else pending.resolve(object(message.result))
    })
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    const fail = (error: Error) => {
      if (this.failure) return
      this.failure = error
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(error)
      }
      this.pending.clear()
      this.onExit(error)
    }
    this.child.on('error', fail)
    this.child.on('exit', (code, signal) =>
      fail(new Error(`Provider exited (${code ?? signal})`)),
    )
  }
  send(value: unknown) {
    if (!this.failure && this.child.stdin.writable)
      this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  request(method: string, params: unknown = {}): Promise<ObjectValue> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }
  close() {
    this.child.stdin.end()
    setTimeout(() => this.child.kill(), 1500).unref()
  }
}
