import { app, Menu, nativeImage, Tray } from 'electron'
import { readFileSync } from 'node:fs'
import appIconPath from './assets/macos-icon-1024.png?asset'
import trayIconPath from './assets/tray-template@2x.png?asset'

/** Brand assets are bundled by electron-vite, including in development. */
export function createDesktopShell(showWindow: () => void) {
  const icon = nativeImage.createFromPath(appIconPath)
  if (icon.isEmpty()) throw new Error('OpenYak application icon is missing')
  if (process.platform === 'darwin') app.dock?.setIcon(icon)

  let trayImage = icon.resize({ width: 24, height: 24 })
  if (process.platform === 'darwin') {
    // v1's template is 87x46 pixels, not an exact 2x companion of its 44x24
    // file. Normalize both representations from the same high-resolution art.
    // Explicit representations also survive hashed asset filenames.
    const source = nativeImage.createFromBuffer(readFileSync(trayIconPath))
    if (source.isEmpty()) throw new Error('OpenYak menu bar icon is missing')
    const height = 18
    const width = Math.round(source.getSize().width * height / source.getSize().height)
    trayImage = source.resize({ width, height, quality: 'best' })
    trayImage.addRepresentation({ scaleFactor: 2, buffer: source.resize({ width: width * 2, height: height * 2, quality: 'best' }).toPNG() })
    trayImage.setTemplateImage(true)
  }

  const tray = new Tray(trayImage)
  tray.setToolTip('OpenYak')
  const menu = Menu.buildFromTemplate([
    { label: 'Open OpenYak', click: showWindow },
    { type: 'separator' },
    { label: 'Quit OpenYak', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  // Like v1, clicking the menu bar icon also brings the app forward.
  tray.on('click', showWindow)
  return { icon, tray, trayImage, menu, dispose: () => tray.destroy() }
}
