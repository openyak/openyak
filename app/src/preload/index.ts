import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CoreExit,
  ElicitationRequest,
  ElicitationResponse,
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

  onElicitationRequest(cb) {
    const listener = (
      _e: Electron.IpcRendererEvent,
      msg: { key: string; params: ElicitationRequest },
    ) => {
      void cb(msg.params)
        .then((res: ElicitationResponse | null) => res ?? { action: 'cancel' })
        .catch(() => ({ action: 'cancel' as const }))
        .then((result) => ipcRenderer.send('core:elicitation-response', { key: msg.key, result }))
    }
    ipcRenderer.on('core:elicitation-request', listener)
    return () => ipcRenderer.off('core:elicitation-request', listener)
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

  resolveProjectFile(projectPath, reference) {
    return ipcRenderer.invoke('file:resolve', projectPath, reference)
  },

  inspectProjectFile(projectPath, reference) {
    return ipcRenderer.invoke('file:inspect', projectPath, reference)
  },

  openProjectFile(projectPath, reference) {
    return ipcRenderer.invoke('file:open', projectPath, reference) as Promise<void>
  },

  revealProjectFile(projectPath, reference) {
    return ipcRenderer.invoke('file:reveal', projectPath, reference) as Promise<void>
  },

  codexCapabilities(projectPath = null) {
    return ipcRenderer.invoke('codex:capabilities', projectPath)
  },

  setCodexSkillEnabled(path, enabled) {
    return ipcRenderer.invoke('codex:skill-enabled', path, enabled) as Promise<boolean>
  },

  inspectArtifact(taskId, projectPath, artifact) {
    return ipcRenderer.invoke('artifact:inspect', taskId, projectPath, artifact)
  },

  openArtifact(taskId, projectPath, filePath) {
    return ipcRenderer.invoke('artifact:open', taskId, projectPath, filePath) as Promise<void>
  },

  revealArtifact(taskId, projectPath, filePath) {
    return ipcRenderer.invoke('artifact:reveal', taskId, projectPath, filePath) as Promise<void>
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
