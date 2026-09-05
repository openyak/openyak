import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession, type Dialog } from 'playwright'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { BrowserCommand, BrowserFrame, BrowserState } from '../shared/browser'
import { BrowserControl, browserUrl } from './browser-control'

interface PageEntry { page: Page; cdp?: CDPSession; title: string; dialog?: Dialog }

/** Dedicated Chromium, no Electron debug port, preload, or shared user profile. */
class TaskBrowser {
  readonly token = randomUUID()
  readonly control = new BrowserControl(() => this.publish())
  readonly pages = new Map<string, PageEntry>()
  readonly connections = new Map<string, StreamableHTTPServerTransport>()
  private browser?: Browser
  private contextPromise?: Promise<BrowserContext>
  private clientPromise?: Promise<Client>
  private official?: Awaited<ReturnType<typeof createConnection>>
  private watching: string | null = null
  private activePageId: string | null = null
  private closed = false
  private error?: string
  private watchSequence = 0
  constructor(readonly taskId: string, readonly cwd: string,
    private emit: (state: BrowserState) => void,
    private frame: (frame: BrowserFrame) => void) {}

  state(): BrowserState {
    const pending = [...this.pages].find(([, entry]) => entry.dialog)
    const dialog = pending?.[1].dialog
    return { taskId: this.taskId, control: this.control.mode, activePageId: this.activePageId,
      pages: [...this.pages].map(([id, { page, title }]) => ({ id, title, url: page.url() })), error: this.error,
      ...(dialog && pending ? { dialog: { pageId: pending[0], type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() } } : {}) }
  }
  publish() { if (!this.closed) this.emit(this.state()) }

  private context(): Promise<BrowserContext> {
    this.contextPromise ??= (async () => {
      // Use installed Chrome, or the administrator-selected Playwright executable.
      const browser = await chromium.launch({ headless: true,
        ...(process.env.OPENYAK_BROWSER_EXECUTABLE
          ? { executablePath: process.env.OPENYAK_BROWSER_EXECUTABLE } : { channel: 'chrome' }),
        chromiumSandbox: true })
      this.browser = browser
      if (this.closed) { await browser.close(); throw new Error('Browser session closed') }
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 },
        deviceScaleFactor: 2, acceptDownloads: false, serviceWorkers: 'block' })
      this.error = undefined
      context.on('close', () => {
        if (this.browser === browser) { this.browser = undefined; this.contextPromise = undefined }
        void browser.close().catch(() => {})
      })
      await context.route('**/*', async route => {
        const protocol = new URL(route.request().url()).protocol
        if (['http:', 'https:'].includes(protocol)) await route.continue()
        else await route.abort()
      })
      context.on('page', page => this.addPage(page))
      browser.on('disconnected', () => {
        if (!this.closed && this.browser === browser) {
          this.contextPromise = undefined
          this.browser = undefined
          this.error = 'Browser disconnected. Open a new browser tab to retry.'
          this.publish()
        }
      })
      return context
    })().catch(error => {
      this.error = `Browser unavailable: ${String(error)}`
      this.contextPromise = undefined
      this.publish()
      throw error
    })
    return this.contextPromise
  }

  private addPage(page: Page) {
    const id = randomUUID()
    this.pages.set(id, { page, title: 'New tab' })
    this.activePageId = id
    page.on('dialog', dialog => {
      const entry = this.pages.get(id)
      if (!entry) return
      entry.dialog = dialog
      const accept = dialog.accept.bind(dialog)
      const dismiss = dialog.dismiss.bind(dialog)
      const clear = () => { if (entry.dialog === dialog) { entry.dialog = undefined; this.publish() } }
      dialog.accept = async text => { await accept(text); clear() }
      dialog.dismiss = async () => { await dismiss(); clear() }
      this.publish()
    })
    const update = async () => {
      const entry = this.pages.get(id)
      if (!entry || page.isClosed()) return
      entry.title = await page.title().catch(() => '') || 'New tab'
      this.publish()
    }
    page.on('domcontentloaded', () => { void update() })
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) { this.activePageId = id; void update() }
    })
    page.on('close', () => {
      this.pages.delete(id)
      if (this.activePageId === id) this.activePageId = [...this.pages.keys()].at(-1) ?? null
      if (this.watching === id) this.watching = null
      this.publish()
    })
    // Playwright's public bringToFront is the shared selection boundary.
    const bringToFront = page.bringToFront.bind(page)
    page.bringToFront = async () => { await bringToFront(); this.activePageId = id; this.publish() }
    this.publish()
  }

  async client(): Promise<Client> {
    this.clientPromise ??= (async () => {
      this.official = await createConnection({
        outputDir: join(this.cwd, '.playwright-mcp'),
        capabilities: ['core', 'vision'], sharedBrowserContext: true }, () => this.context())
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'openyak-browser-host', version: '1.0.0' }, { capabilities: { roots: {} } })
      client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(this.cwd).href, name: 'Task workspace' }] }))
      await this.official.connect(serverTransport)
      await client.connect(clientTransport)
      return client
    })()
    return this.clientPromise
  }

  async connect(req: IncomingMessage, res: ServerResponse) {
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? this.connections.get(sessionId) : undefined
    if (!transport) {
      if (sessionId || req.method !== 'POST') { res.writeHead(404).end(); return }
      const client = await this.client()
      const proxy = new Server({ name: 'openyak-browser', version: '1.0.0' }, { capabilities: { tools: {} } })
      // Official schemas and descriptions are forwarded unchanged. No tool-name guessing.
      proxy.setRequestHandler(ListToolsRequestSchema, () => client.listTools())
      proxy.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        try {
          return await this.control.run(async () => {
            const result = await client.callTool(request.params, undefined, { timeout: 120_000, signal: extra.signal }).catch(async error => {
              // A transport timeout is not proof that the operation stopped.
              // Close its isolated browser before releasing the takeover barrier.
              await this.browser?.close().catch(() => {})
              throw error
            })
            this.publish()
            return result
          })
        } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] } }
      })
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: id => { this.connections.set(id, created) } })
      await proxy.connect(created)
      const onClose = created.onclose
      created.onclose = () => { onClose?.(); if (created.sessionId) this.connections.delete(created.sessionId) }
      transport = created
    }
    await transport.handleRequest(req, res)
  }

  private page(id: string): Page {
    const page = this.pages.get(id)?.page
    if (!page || page.isClosed()) throw new Error('Browser tab is closed')
    return page
  }
  async command(command: BrowserCommand) {
    if (command.type === 'takeover') { this.control.takeOver(); return }
    if (command.type === 'resume') {
      this.control.requireUser()
      if (this.watching) {
        // Public Playwright MCP tab contract; keep its current tab aligned with
        // the user-selected page before allowing the agent to run again.
        const index = [...this.pages.keys()].indexOf(this.watching)
        const result = await (await this.client()).callTool({ name: 'browser_tabs', arguments: { action: 'select', index } })
        if (result.isError) throw new Error('Could not synchronize the browser tab. Agent control remains paused.')
      }
      this.control.resume(); return
    }
    if (command.type === 'watch') { await this.watch(command.pageId, command.width, command.height, command.deviceScaleFactor); return }
    this.control.requireUser()
    if (command.type === 'new') {
      const page = await (await this.context()).newPage()
      if (command.url) await page.goto(browserUrl(command.url))
      return
    }
    if (!('pageId' in command)) throw new Error('Unknown browser command')
    const page = this.page(command.pageId)
    switch (command.type) {
      case 'navigate': await page.goto(browserUrl(command.url)); break
      case 'back': await page.goBack(); break
      case 'forward': await page.goForward(); break
      case 'reload': await page.reload(); break
      case 'close': await page.close(); break
      case 'pointer':
        if (![command.x, command.y].every(Number.isFinite)) throw new Error('Invalid coordinates')
        await page.mouse.move(command.x, command.y)
        if (command.action === 'down') await page.mouse.down({ button: command.button })
        if (command.action === 'up') await page.mouse.up({ button: command.button })
        break
      case 'wheel': await page.mouse.wheel(command.x, command.y); break
      case 'key': await page.keyboard.press(command.key); break
      case 'text': await page.keyboard.insertText(command.text.slice(0, 100_000)); break
      case 'dialog': {
        const entry = this.pages.get(command.pageId)!
        const dialog = entry.dialog
        if (!dialog) throw new Error('The page dialog is already closed')
        entry.dialog = undefined
        if (command.accept) await dialog.accept(command.text)
        else await dialog.dismiss()
        break
      }
    }
    this.publish()
  }

  private async watch(id: string | null, width = 1100, height = 800, deviceScaleFactor = 2) {
    const sequence = ++this.watchSequence
    this.watching = id
    for (const entry of this.pages.values()) {
      if (entry.cdp) { await entry.cdp.detach().catch(() => {}); entry.cdp = undefined }
    }
    if (!id || sequence !== this.watchSequence) return
    const page = this.page(id)
    const size = { width: Math.max(320, Math.min(2560, Math.round(width) || 1100)), height: Math.max(200, Math.min(1600, Math.round(height) || 800)) }
    await page.setViewportSize(size)
    if (sequence !== this.watchSequence) return
    const cdp = await page.context().newCDPSession(page)
    if (sequence !== this.watchSequence) { await cdp.detach(); return }
    this.pages.get(id)!.cdp = cdp
    // Screencast maxWidth/maxHeight are only ceilings: Chrome still emits 1x
    // frames on Retina. Capture from the compositor surface at the host DPR.
    const density = Number.isFinite(deviceScaleFactor) ? Math.max(1, Math.min(3, deviceScaleFactor)) : 2
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: density, mobile: false })
    const current = () => sequence === this.watchSequence && this.watching === id && !this.closed && this.pages.get(id)?.cdp === cdp
    let capturing = false
    let dirty = false
    const capture = async () => {
      dirty = true
      if (capturing) return
      capturing = true
      try {
        // Single-flight, with at most one pending refresh. Never queue a frame
        // per event; slow PNG encoding must not build a backlog of old images.
        if (current()) {
          dirty = false
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
          if (current()) this.frame({ taskId: this.taskId, pageId: id, data, mimeType: 'image/png', ...size })
        }
      } catch (error) {
        if (current()) { this.error = `Browser display unavailable: ${String(error)}`; this.publish() }
      } finally {
        capturing = false
        if (dirty && current()) void capture()
      }
    }
    cdp.on('Page.screencastFrame', event => {
      // Use screencast only for paint notifications. Its low-resolution image
      // never reaches the renderer; PNG surface captures preserve text edges.
      void capture().finally(() => cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}))
    })
    if (!current()) return
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 })
    await capture()
  }
  async close() {
    this.closed = true
    for (const transport of this.connections.values()) await transport.close().catch(() => {})
    await this.official?.close().catch(() => {})
    await this.browser?.close().catch(() => {})
  }
}

export class BrowserHost {
  private tasks = new Map<string, TaskBrowser>()
  private secret = randomUUID()
  private server = createServer((req, res) => { void this.http(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  private origin = ''
  constructor(private emit: (state: BrowserState) => void, private frame: (frame: BrowserFrame) => void) {}
  async start() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Browser host failed to start')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  environment() { return { OPENYAK_BROWSER_HOST: this.origin, OPENYAK_BROWSER_SECRET: this.secret } }
  ensure(taskId: string, cwd: string) {
    let task = this.tasks.get(taskId)
    if (!task) { task = new TaskBrowser(taskId, cwd, this.emit, this.frame); this.tasks.set(taskId, task) }
    return task
  }
  list() { return [...this.tasks.values()].map(task => task.state()) }
  async unwatchAll() {
    await Promise.all([...this.tasks.values()].map(task => task.command({ type: 'watch', pageId: null }).catch(() => {})))
  }
  async command(taskId: string, command: BrowserCommand) {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('No browser session for this task')
    await task.command(command)
    return task.state()
  }
  async forget(taskId: string) { const task = this.tasks.get(taskId); this.tasks.delete(taskId); await task?.close() }
  private async http(req: IncomingMessage, res: ServerResponse) {
    // No web origin is allowed, even localhost. Only authenticated native clients.
    if (req.headers.origin || req.headers.host !== new URL(this.origin).host) { res.writeHead(403).end(); return }
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/session' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${this.secret}`) { res.writeHead(403).end(); return }
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 8192) { res.writeHead(413).end(); return } }
      const { taskId, cwd } = JSON.parse(body)
      if (typeof taskId !== 'string' || !taskId || typeof cwd !== 'string') { res.writeHead(400).end(); return }
      const task = this.ensure(taskId, cwd)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ url: `${this.origin}/mcp/${task.token}` }))
      return
    }
    const task = [...this.tasks.values()].find(task => url.pathname === `/mcp/${task.token}`)
    if (!task) { res.writeHead(404).end(); return }
    await task.connect(req, res)
  }
  async close() {
    await Promise.all([...this.tasks.values()].map(task => task.close()))
    this.tasks.clear()
    this.server.closeAllConnections()
    this.server.close()
  }
}
