import { useEffect, useRef, useState } from 'react'
import type { BrowserCommand, BrowserState } from '../../shared/browser'
import { IconChevronRight, IconRetry, IconHand, IconPlay } from './icons'

export function BrowserPanel({ taskId, pageId, state }: { taskId: string; pageId: string; state?: BrowserState }) {
  const page = state?.pages.find(page => page.id === pageId)
  const [draft, setDraft] = useState<{ url: string; value: string } | null>(null)
  const address = draft && draft.url === page?.url ? draft.value : page?.url === 'about:blank' ? '' : page?.url ?? ''
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [dialogText, setDialogText] = useState('')
  const surface = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewport = useRef({ width: 1100, height: 800 })
  const input = useRef<HTMLTextAreaElement>(null)
  const user = state?.control === 'user'
  const queue = useRef(Promise.resolve())
  const send = (command: BrowserCommand) => {
    if (command.type === 'dialog' || command.type === 'takeover') {
      void window.openyak.browserCommand(taskId, command).catch(error => setError(String(error)))
      return
    }
    // Preserve mouse down/up and keyboard order even across IPC round trips.
    queue.current = queue.current.then(async () => {
      await window.openyak.browserCommand(taskId, command)
    }).catch(error => setError(String(error)))
  }
  useEffect(() => {
    let live = true
    let sequence = 0
    const unsubscribe = window.openyak.onBrowserFrame(frame => {
      if (frame.taskId !== taskId || frame.pageId !== pageId) return
      const current = ++sequence
      const image = new Image()
      image.onload = () => {
        if (!live || current !== sequence || !canvas.current) return
        const element = canvas.current
        viewport.current = { width: frame.width, height: frame.height }
        if (element.width !== image.naturalWidth || element.height !== image.naturalHeight) {
          element.width = image.naturalWidth; element.height = image.naturalHeight
        }
        element.getContext('2d')?.drawImage(image, 0, 0)
        setReady(true)
      }
      image.src = `data:${frame.mimeType};base64,${frame.data}`
    })
    let timer: ReturnType<typeof setTimeout>
    const resize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const bounds = surface.current?.getBoundingClientRect()
        if (bounds && live) void window.openyak.browserCommand(taskId, { type: 'watch', pageId, width: bounds.width, height: bounds.height, deviceScaleFactor: window.devicePixelRatio }).catch(error => setError(String(error)))
      }, 100)
    }
    const observer = new ResizeObserver(resize)
    if (surface.current) observer.observe(surface.current)
    // Moving the window between monitors can change DPR without a CSS resize.
    let densityQuery: MediaQueryList
    const densityChanged = () => {
      densityQuery?.removeEventListener('change', densityChanged)
      densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      densityQuery.addEventListener('change', densityChanged)
      resize()
    }
    densityChanged()
    resize()
    return () => {
      live = false; clearTimeout(timer); observer.disconnect(); unsubscribe()
      densityQuery.removeEventListener('change', densityChanged)
      void window.openyak.browserCommand(taskId, { type: 'watch', pageId: null }).catch(() => {})
    }
  }, [taskId, pageId])

  return <div className="browser-panel">
    <form className="browser-toolbar" onSubmit={event => {
      event.preventDefault(); setError('')
      send({ type: 'navigate', pageId, url: /^https?:\/\//i.test(address) ? address : `https://${address}` })
    }}>
      <button type="button" className="icon-btn browser-back" aria-label="Go back" disabled={!user} onClick={() => send({ type: 'back', pageId })}><IconChevronRight size={16} /></button>
      <button type="button" className="icon-btn" aria-label="Go forward" disabled={!user} onClick={() => send({ type: 'forward', pageId })}><IconChevronRight size={16} /></button>
      <button type="button" className="icon-btn" aria-label="Reload page" disabled={!user} onClick={() => send({ type: 'reload', pageId })}><IconRetry size={16} /></button>
      <input aria-label="Browser address" placeholder="Enter a URL" value={address} onChange={event => setDraft({ url: page?.url ?? '', value: event.target.value })} readOnly={!user} spellCheck={false} />
      <button type="button" className="browser-control" disabled={state?.control === 'taking-over'} onClick={() => send({ type: user ? 'resume' : 'takeover' })}>
        {user ? <IconPlay size={14} /> : <IconHand size={14} />}
        {user ? 'Resume agent' : state?.control === 'taking-over' ? 'Finishing action…' : 'Take control'}
      </button>
    </form>
    {(error || state?.error) && <div className="browser-error" role="alert">{error || state?.error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="browser-surface" ref={surface}>
      <canvas ref={canvas} aria-label="Live browser page" className={user ? 'is-interactive' : ''}
        onPointerDown={event => {
          if (!user) return
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); input.current?.focus()
          const bounds = event.currentTarget.getBoundingClientRect()
          send({ type: 'pointer', pageId, action: 'down', x: (event.clientX - bounds.left) * viewport.current.width / bounds.width, y: (event.clientY - bounds.top) * viewport.current.height / bounds.height, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' })
        }}
        onPointerUp={event => {
          if (!user) return
          const bounds = event.currentTarget.getBoundingClientRect()
          send({ type: 'pointer', pageId, action: 'up', x: (event.clientX - bounds.left) * viewport.current.width / bounds.width, y: (event.clientY - bounds.top) * viewport.current.height / bounds.height, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' })
        }}
        onPointerMove={event => {
          if (!user || !event.buttons) return
          const bounds = event.currentTarget.getBoundingClientRect()
          send({ type: 'pointer', pageId, action: 'move', x: (event.clientX - bounds.left) * viewport.current.width / bounds.width, y: (event.clientY - bounds.top) * viewport.current.height / bounds.height, button: 'left' })
        }}
        onContextMenu={event => event.preventDefault()}
        onWheel={event => { if (user) send({ type: 'wheel', pageId, x: event.deltaX, y: event.deltaY }) }}
      />
      {!ready && <div className="browser-empty">Connecting to the live browser…</div>}
      {state?.dialog?.pageId === pageId && <div className="browser-dialog" role="dialog" aria-label="Browser page dialog">
        <p>{state.dialog.message}</p>
        {state.dialog.type === 'prompt' && <input aria-label="Dialog response" value={dialogText} onChange={event => setDialogText(event.target.value)} />}
        <button disabled={!user} onClick={() => send({ type: 'dialog', pageId, accept: false })}>Dismiss</button>
        <button disabled={!user} onClick={() => send({ type: 'dialog', pageId, accept: true, text: dialogText || state.dialog?.defaultValue })}>OK</button>
        {!user && <small>Take control to respond, or let the agent handle this dialog.</small>}
      </div>}
      <textarea className="browser-keyboard" ref={input} aria-label="Type into browser" disabled={!user}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.key === 'Process') return
          // Printable input (including IME) is forwarded by onChange.
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return
          if (['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
          event.preventDefault()
          const modifiers = [event.ctrlKey && 'Control', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean)
          send({ type: 'key', pageId, key: [...modifiers, event.key].join('+') })
        }}
        onChange={event => {
          if (!(event.nativeEvent as InputEvent).isComposing) { send({ type: 'text', pageId, text: event.target.value }); event.target.value = '' }
        }}
        onCompositionEnd={event => { send({ type: 'text', pageId, text: event.data }); event.currentTarget.value = '' }}
      />
    </div>
    <div className="browser-status" role="status">{user ? 'You have control · agent browser actions are paused' : state?.control === 'taking-over' ? 'Waiting for the current agent action to finish' : 'Live browser · agent control'}<span>Isolated session</span></div>
  </div>
}
