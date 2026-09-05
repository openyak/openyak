/** User takeover is a barrier: reject new calls and drain in-flight work first. */
export class BrowserControl {
  mode: 'agent' | 'taking-over' | 'user' = 'agent'
  private active = 0
  private tail: Promise<unknown> = Promise.resolve()
  private changed: () => void
  constructor(changed: () => void) { this.changed = changed }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mode !== 'agent') throw new Error('The user has taken control of this browser. Wait for them to resume agent control.')
    const result = this.tail.then(() => this.execute(operation))
    this.tail = result.catch(() => {})
    return result
  }
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mode !== 'agent') throw new Error('Browser is under user control; the queued action was not executed.')
    this.active++
    try { return await operation() }
    finally {
      this.active--
      this.finishTakeover()
      this.changed()
    }
  }
  private finishTakeover() { if (!this.active && this.mode === 'taking-over') this.mode = 'user' }
  takeOver() {
    this.mode = this.active ? 'taking-over' : 'user'
    this.changed()
  }
  resume() {
    if (this.mode === 'taking-over') throw new Error('Wait for the current browser operation to finish.')
    this.mode = 'agent'
    this.changed()
  }
  requireUser() {
    if (this.mode !== 'user') throw new Error('Take control of the browser before interacting.')
  }
}

export function browserUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP and HTTPS browser URLs are allowed.')
  return url.href
}
