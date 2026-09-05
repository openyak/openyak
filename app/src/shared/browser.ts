/** Ephemeral browser state, never transcript content or credentials. */
export interface BrowserPageState { id: string; title: string; url: string }
export interface BrowserState {
  taskId: string
  pages: BrowserPageState[]
  activePageId: string | null
  control: 'agent' | 'taking-over' | 'user'
  error?: string
  dialog?: { pageId: string; type: string; message: string; defaultValue: string }
}
/** width/height are CSS coordinates; the encoded image includes display-density pixels. */
export interface BrowserFrame { taskId: string; pageId: string; data: string; mimeType: 'image/png'; width: number; height: number }
export type BrowserCommand =
  | { type: 'new'; url?: string }
  | { type: 'navigate'; pageId: string; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'close'; pageId: string }
  | { type: 'takeover' | 'resume' }
  | { type: 'watch'; pageId: string | null; width?: number; height?: number; deviceScaleFactor?: number }
  | { type: 'pointer'; pageId: string; action: 'move' | 'down' | 'up'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { type: 'wheel'; pageId: string; x: number; y: number }
  | { type: 'key'; pageId: string; key: string }
  | { type: 'text'; pageId: string; text: string }
  | { type: 'dialog'; pageId: string; accept: boolean; text?: string }
