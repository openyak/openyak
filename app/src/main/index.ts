import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CoreClient, CoreError } from './core-client'
import { saveDiagramSvg } from './save-diagram'
import { saveImageAttachment } from './save-image'
import { agentHostProfiles } from './agent-host-profiles'
import { CodexHostClient } from './codex-host'
import { resolveProjectFile } from './project-file-host'
import { taskFileRoot } from './task-file-context'
import {
  inspectProjectFilePreview,
  installProjectFileProtocol,
  projectFileScheme,
} from './project-file-preview'
import {
  artifactScheme,
  forgetArtifactGrants,
  grantArtifactPath,
  inspectArtifact,
  installArtifactProtocol,
  resolveArtifactPath,
} from './artifact-host'
import type {
  CodexHostCapabilities,
  CodexMcpServerSummary,
  CodexSkillSummary,
} from '../shared/protocol'

let win: BrowserWindow | null = null
let core: CoreClient | null = null
const codexHost = new CodexHostClient()

// Allows isolated desktop integration tests without touching the user's Chats.
if (process.env.OPENYAK_DATA_DIR) app.setPath('userData', path.resolve(process.env.OPENYAK_DATA_DIR))

protocol.registerSchemesAsPrivileged([artifactScheme(), projectFileScheme()])

function grantFromArtifactPart(taskId: unknown, partValue: unknown): void {
  if (typeof taskId !== 'string' || partValue == null || typeof partValue !== 'object') return
  const part = partValue as { type?: unknown; kind?: unknown; data?: unknown }
  if (part.type !== 'event' || typeof part.kind !== 'string' || !part.kind.startsWith('artifact.')) return
  if (part.data == null || typeof part.data !== 'object') return
  const data = part.data as { artifact?: { path?: unknown }; artifacts?: Array<{ path?: unknown }> }
  grantArtifactPath(taskId, data.artifact?.path)
  for (const artifact of Array.isArray(data.artifacts) ? data.artifacts : []) {
    grantArtifactPath(taskId, artifact.path)
  }
}

function grantFromCoreNotification(method: string, params: unknown): void {
  if (method !== 'chat.update' || params == null || typeof params !== 'object') return
  const update = params as { task_id?: unknown; part?: unknown }
  grantFromArtifactPart(update.task_id, update.part)
}

function grantFromHistory(result: unknown): void {
  if (!Array.isArray(result)) return
  for (const messageValue of result) {
    if (messageValue == null || typeof messageValue !== 'object') continue
    const message = messageValue as { task_id?: unknown; parts?: unknown[] }
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      grantFromArtifactPart(message.task_id, part)
    }
  }
}

function resolveCoreBinary(): string {
  if (process.env.OPENYAK_CORE_BIN) return process.env.OPENYAK_CORE_BIN
  const dev = path.resolve(app.getAppPath(), '..', 'core', 'target', 'release', 'openyak-core')
  if (!app.isPackaged && existsSync(dev)) return dev
  return path.join(process.resourcesPath, 'openyak-core')
}

/**
 * PATH as the user's login shell sees it. An app launched from the Dock or Finder gets a
 * bare one, which is where the agents look for `git` and the tools they run.
 */
function shellPath(): string | null {
  if (process.platform === 'win32') return null
  const sh = process.env.SHELL || '/bin/zsh'
  try {
    const out = execFileSync(sh, ['-ilc', 'echo -n "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * The ACP adapters bundled with the app, one per agent, run with Electron's own Node.
 * Claude Code and Codex themselves ship inside the adapters; they use the sign-in the
 * user already has on this machine.
 */
function adapters(): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  return {
    claude: {
      command: process.execPath,
      args: [require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')],
      env,
    },
    codex: {
      command: process.execPath,
      args: [require.resolve('@agentclientprotocol/codex-acp/dist/index.js')],
      env,
    },
  }
}

function startCore(): CoreClient {
  const binary = resolveCoreBinary()
  const dataDir = app.getPath('userData')
  const shPath = shellPath()
  if (shPath) process.env.PATH = shPath
  const args = [
    '--data-dir',
    dataDir,
    '--adapters',
    JSON.stringify(adapters()),
    '--session-profiles',
    JSON.stringify(agentHostProfiles()),
    '--runtimes',
    JSON.stringify(process.env.OPENYAK_AGENT_TRANSPORT === 'acp' ? {} : Object.fromEntries(
      ['codex', 'claude'].map(agent => [agent, {
        command: process.execPath,
        args: [path.join(__dirname, 'runtime-worker.js'), agent],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }]),
    )),
  ]
  if (import.meta.env.DEV) console.log(`[main] spawning core: ${binary} ${args.join(' ')}`)
  const client = new CoreClient(binary, args)
  const pendingRequests = new Map<string, () => void>()

  client.on('notification', (method: string, params: unknown) => {
    if (method === 'runtime.request.closed') {
      const id = (params as { request_id: string }).request_id
      pendingRequests.get(id)?.()
    }
    grantFromCoreNotification(method, params)
    win?.webContents.send('core:notification', { method, params })
  })

  client.on('request', (id: number | string, method: string, params: unknown) => {
    if (!win) {
      client.respondError(id, -32601, `Method not found: ${method}`)
      return
    }
    if (method === 'elicitation.request') {
      const request = params as { mode?: unknown; url?: unknown }
      if (request.mode !== 'form' && request.mode !== 'url') {
        client.respond(id, { action: 'cancel' })
        return
      }
      const key = String(id)
      const cleanup = () => {
        ipcMain.off('core:elicitation-response', onResponse)
        pendingRequests.delete(key)
      }
      const onResponse = (_e: Electron.IpcMainEvent, payload: { key: string; result: unknown }) => {
        if (payload.key !== key || _e.sender !== win?.webContents) return
        cleanup()
        client.respond(id, payload.result ?? { action: 'cancel' })
      }
      ipcMain.on('core:elicitation-response', onResponse)
      pendingRequests.set(key, cleanup)
      win.webContents.send('core:elicitation-request', { key, params })
      return
    }
    if (method !== 'permission.request') {
      client.respondError(id, -32601, `Method not found: ${method}`)
      return
    }
    const key = String(id)
    const cleanup = () => {
      ipcMain.off('core:permission-response', onResponse)
      pendingRequests.delete(key)
    }
    const onResponse = (_e: Electron.IpcMainEvent, payload: { key: string; result: unknown }) => {
      if (payload.key !== key || _e.sender !== win?.webContents) return
      cleanup()
      client.respond(id, payload.result ?? { option_id: null })
    }
    ipcMain.on('core:permission-response', onResponse)
    pendingRequests.set(key, cleanup)
    win.webContents.send('core:permission-request', { key, params })
  })

  client.on('exit', (code: number | null, signal: string | null) => {
    for (const cleanup of pendingRequests.values()) cleanup()
    console.error(`[main] core exited: code=${code} signal=${signal}`)
    win?.webContents.send('core:exited', { code, signal })
  })

  return client
}

// Window chrome matches the renderer's theme so there is no flash on launch and the
// title-bar area (macOS traffic lights sit over the sidebar) blends in.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#171717' : '#f4f3e8')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'OpenYak',
    backgroundColor: windowBackground(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (import.meta.env.DEV) {
    win.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`)
    })
  }

  win.on('closed', () => {
    win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

nativeTheme.on('updated', () => {
  win?.setBackgroundColor(windowBackground())
})

ipcMain.handle('core:request', async (_e, method: string, params: unknown) => {
  if (!core) throw new Error('core is not running')
  try {
    const result = await core.request(method, params)
    if (method === 'chat.history') grantFromHistory(result)
    if (method === 'task.delete' && params != null && typeof params === 'object') {
      forgetArtifactGrants((params as { task_id?: unknown }).task_id)
    }
    return result
  } catch (err) {
    // Errors crossing IPC lose their fields; flatten to a message string.
    if (err instanceof CoreError) throw new Error(`${err.message} (code ${err.code})`)
    throw err
  }
})

ipcMain.handle('dialog:pick-directory', async () => {
  const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
})

ipcMain.handle('dialog:pick-files', async () => {
  const opts: Electron.OpenDialogOptions = {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('diagram:save', async (_event, value: unknown) => {
  const options: Electron.SaveDialogOptions = {
    title: 'Save diagram',
    defaultPath: 'diagram.svg',
    filters: [{ name: 'SVG image', extensions: ['svg'] }],
  }
  return saveDiagramSvg(
    value,
    () => (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)),
    (filePath, data) => writeFile(filePath, data, 'utf8'),
  )
})

ipcMain.handle('image:save', async (_event, value: unknown) => {
  return saveImageAttachment(
    value,
    (image) => {
      const options: Electron.SaveDialogOptions = {
        title: 'Save image',
        defaultPath: image.suggestedName,
        filters: [{ name: 'Image', extensions: [image.extension] }],
      }
      return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
    },
    (filePath, data) => writeFile(filePath, data),
  )
})

ipcMain.handle('shell:open-external', async (_event, value: unknown) => {
  if (typeof value !== 'string') throw new Error('Expected an HTTPS URL')
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs can be opened')
  await shell.openExternal(url.toString())
})

const fileRoot = (task: unknown) => taskFileRoot(task, (method, params) => {
  if (!core) throw new Error('Core is not running')
  return core.request(method, params)
})

ipcMain.handle('file:resolve', async (_event, task: unknown, reference: unknown) =>
  resolveProjectFile(await fileRoot(task), reference),
)

ipcMain.handle('file:inspect', async (_event, task: unknown, reference: unknown) =>
  inspectProjectFilePreview(await fileRoot(task), reference),
)

ipcMain.handle('file:open', async (_event, task: unknown, reference: unknown) => {
  const file = await resolveProjectFile(await fileRoot(task), reference)
  if (!file) throw new Error('File is not available in the active project')
  const error = await shell.openPath(file.path)
  if (error) throw new Error(error)
})

ipcMain.handle('file:reveal', async (_event, task: unknown, reference: unknown) => {
  const file = await resolveProjectFile(await fileRoot(task), reference)
  if (!file) throw new Error('File is not available in the active project')
  shell.showItemInFolder(file.path)
})

const record = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

async function collectCodexPages(method: string, params: Record<string, unknown>): Promise<{ data: unknown[] }> {
  const data: unknown[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const result = record(await codexHost.request(method, { ...params, cursor }))
    data.push(...list(result.data))
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
    if (cursor && cursors.has(cursor)) throw new Error(`${method} returned a repeated cursor`)
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return { data }
}

ipcMain.handle('codex:capabilities', async (_event, projectPath: unknown) => {
  const cwds = typeof projectPath === 'string' && projectPath ? [projectPath] : []
  const calls = await Promise.allSettled([
    codexHost.request('skills/list', { cwds, forceReload: true }),
    collectCodexPages('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }),
    codexHost.request('app/installed', { forceRefresh: false }),
  ])
  const errors = calls.flatMap((result) =>
    result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [],
  )

  const skillsResult = calls[0].status === 'fulfilled' ? record(calls[0].value) : {}
  const skills: CodexSkillSummary[] = list(skillsResult.data).flatMap((entryValue) =>
    list(record(entryValue).skills).map((skillValue) => {
      const skill = record(skillValue)
      return {
        name: typeof skill.name === 'string' ? skill.name : '',
        description: typeof skill.description === 'string' ? skill.description : '',
        path: typeof skill.path === 'string' ? skill.path : '',
        enabled: skill.enabled !== false,
        pluginId: typeof skill.pluginId === 'string' ? skill.pluginId : null,
      }
    }),
  )

  const mcpResult = calls[1].status === 'fulfilled' ? record(calls[1].value) : {}
  const mcpServers: CodexMcpServerSummary[] = list(mcpResult.data).map((serverValue) => {
    const server = record(serverValue)
    return {
      name: typeof server.name === 'string' ? server.name : '',
      pluginId: typeof server.pluginId === 'string' ? server.pluginId : null,
      status: typeof server.runtimeStatus === 'string' ? server.runtimeStatus : 'notStarted',
      toolCount: Object.keys(record(server.tools)).length,
    }
  })
  const appsResult = calls[2].status === 'fulfilled' ? record(calls[2].value) : {}
  const capability: CodexHostCapabilities = {
    skills,
    mcpServers,
    appCount: list(appsResult.apps).length,
    errors,
  }
  return capability
})

ipcMain.handle('codex:skill-enabled', async (_event, pathValue: unknown, enabled: unknown) => {
  if (typeof pathValue !== 'string' || typeof enabled !== 'boolean') throw new Error('Invalid skill update')
  const result = await codexHost.request<{ effectiveEnabled?: unknown }>('skills/config/write', {
    path: pathValue,
    enabled,
  })
  return result.effectiveEnabled === true
})

ipcMain.handle('artifact:inspect', async (_event, task: unknown, artifact: unknown) =>
  inspectArtifact(task, await fileRoot(task), artifact),
)

ipcMain.handle('artifact:open', async (_event, task: unknown, file: unknown) => {
  const error = await shell.openPath(resolveArtifactPath(task, await fileRoot(task), file))
  if (error) throw new Error(error)
})

ipcMain.handle('artifact:reveal', async (_event, task: unknown, file: unknown) => {
  shell.showItemInFolder(resolveArtifactPath(task, await fileRoot(task), file))
})

ipcMain.handle('theme:set', (_event, value: unknown) => {
  if (value !== 'system' && value !== 'light' && value !== 'dark') {
    throw new Error('Invalid theme preference')
  }
  nativeTheme.themeSource = value
})

app.whenReady().then(() => {
  installArtifactProtocol()
  installProjectFileProtocol()
  core = startCore()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // In development, quit with the window: a lingering windowless process keeps
  // stale main code alive and later hot-loads renderer code it has no handlers for.
  if (process.platform !== 'darwin' || !app.isPackaged) app.quit()
})

app.on('before-quit', () => {
  core?.kill()
  codexHost.kill()
})
