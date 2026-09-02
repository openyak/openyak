import { contextBridge, ipcRenderer } from 'electron'
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
}

contextBridge.exposeInMainWorld('openyak', api)
