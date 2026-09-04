import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CoreClient, CoreError } from './core-client'

let win: BrowserWindow | null = null
let core: CoreClient | null = null

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
  const args = ['--data-dir', dataDir, '--adapters', JSON.stringify(adapters())]
  if (import.meta.env.DEV) console.log(`[main] spawning core: ${binary} ${args.join(' ')}`)
  const client = new CoreClient(binary, args)

  client.on('notification', (method: string, params: unknown) => {
    win?.webContents.send('core:notification', { method, params })
  })

  client.on('request', (id: number | string, method: string, params: unknown) => {
    if (method !== 'permission.request' || !win) {
      client.respondError(id, -32601, `Method not found: ${method}`)
      return
    }
    const key = String(id)
    const onResponse = (_e: Electron.IpcMainEvent, payload: { key: string; result: unknown }) => {
      if (payload.key !== key) return
      ipcMain.off('core:permission-response', onResponse)
      client.respond(id, payload.result ?? { option_id: null })
    }
    ipcMain.on('core:permission-response', onResponse)
    win.webContents.send('core:permission-request', { key, params })
  })

  client.on('exit', (code: number | null, signal: string | null) => {
    console.error(`[main] core exited: code=${code} signal=${signal}`)
    win?.webContents.send('core:exited', { code, signal })
  })

  return client
}

// Window chrome matches the renderer's theme so there is no flash on launch and the
// title-bar area (macOS traffic lights sit over the sidebar) blends in.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#141515' : '#f4f3e8')

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
    void shell.openExternal(url)
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
    return await core.request(method, params)
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

app.whenReady().then(() => {
  core = startCore()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  core?.kill()
})
