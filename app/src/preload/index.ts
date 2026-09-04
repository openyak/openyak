import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CoreExit,
  Notification,
  OpenYakApi,
  PermissionRequest,
  PermissionResponse,
} from '../shared/protocol'

const api: OpenYakApi = {
  request<T>(method: string, params: unknown = {}): Promise<T> {
    return ipcRenderer.invoke('core:request', method, params) as Promise<T>
  },

  onNotification(cb) {
    const listener = (_e: Electron.IpcRendererEvent, n: Notification) => cb(n)
    ipcRenderer.on('core:notification', listener)
    return () => ipcRenderer.off('core:notification', listener)
  },

  onPermissionRequest(cb) {
    const listener = (
      _e: Electron.IpcRendererEvent,
      msg: { key: string; params: PermissionRequest },
    ) => {
      void cb(msg.params)
        .then((res: PermissionResponse | null) => res ?? { option_id: null })
        .catch(() => ({ option_id: null }))
        .then((result) => ipcRenderer.send('core:permission-response', { key: msg.key, result }))
    }
    ipcRenderer.on('core:permission-request', listener)
    return () => ipcRenderer.off('core:permission-request', listener)
  },

  onCoreExited(cb) {
    const listener = (_e: Electron.IpcRendererEvent, exit: CoreExit) => cb(exit)
    ipcRenderer.on('core:exited', listener)
    return () => ipcRenderer.off('core:exited', listener)
  },

  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:pick-directory') as Promise<string | null>
  },

  pickFiles(): Promise<string[]> {
    return ipcRenderer.invoke('dialog:pick-files') as Promise<string[]>
  },

  saveDiagram(svg: string): Promise<boolean> {
    return ipcRenderer.invoke('diagram:save', svg) as Promise<boolean>
  },

  saveImage(image): Promise<boolean> {
    return ipcRenderer.invoke('image:save', image) as Promise<boolean>
  },

  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('shell:open-external', url) as Promise<void>
  },

  setTheme(theme): Promise<void> {
    return ipcRenderer.invoke('theme:set', theme) as Promise<void>
  },

  // Sandboxed renderers do not see File.path; the preload resolves dropped or pasted
  // files to their on-disk path so the agent can be pointed at them.
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
}

contextBridge.exposeInMainWorld('openyak', api)
