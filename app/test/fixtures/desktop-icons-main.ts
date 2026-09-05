import { app, BrowserWindow } from 'electron'
import { createDesktopShell } from '../../src/main/desktop-shell'

if (!process.env.OPENYAK_DATA_DIR) throw new Error('Icon tests require isolated user data')
app.setPath('userData', process.env.OPENYAK_DATA_DIR)
export let desktop: ReturnType<typeof createDesktopShell>
export let dockIconSet = false
export let showCalls = 0
let window: BrowserWindow | null = null
function show() {
  showCalls++
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({ width: 640, height: 480, icon: desktop?.icon })
    void window.loadURL('data:text/html,<title>OpenYak icon acceptance</title><h1>OpenYak icon acceptance</h1>')
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
app.whenReady().then(() => {
  if (app.dock) {
    const setIcon = app.dock.setIcon.bind(app.dock)
    app.dock.setIcon = image => { dockIconSet = true; setIcon(image) }
  }
  desktop = createDesktopShell(show)
  show()
})
app.on('window-all-closed', () => {})
app.on('before-quit', () => desktop?.dispose())
