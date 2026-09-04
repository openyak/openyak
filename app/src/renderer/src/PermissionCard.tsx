import { useId, useRef, useState } from 'react'
import type { PermissionRequest } from '../../shared/protocol'
import { IconFile, IconHand, IconTerminal } from './icons'
import { permissionPresentation } from './permissionPresentation'

export function PermissionCard({ request, agentName, onChoose }: {
  request: PermissionRequest
  agentName: string
  onChoose: (optionId: string | null) => void
}) {
  const model = permissionPresentation(request)
  const { details } = model
  const id = useId()
  const [selected, setSelected] = useState<string | null>(model.initialOptionId)
  const [pending, setPending] = useState(false)
  const sent = useRef(false)
  const choose = (option: string | null) => {
    if (sent.current) return
    sent.current = true
    setPending(true)
    onChoose(option)
  }
  const valid = model.options.some(option => option.id === selected && option.kind !== 'unsupported')
  const Icon = details.kind === 'files' ? IconFile : details.kind === 'command' ? IconTerminal : IconHand
  const category = details.kind === 'files' ? 'File changes' : details.kind === 'command' ? 'Command' : details.kind === 'network' ? 'Network access' : 'Permission'

  return (
    <form className="permission permission-approval" aria-labelledby={`${id}-title`}
      onSubmit={event => { event.preventDefault(); if (valid && !pending) choose(selected) }}
      onKeyDown={event => {
        // Scoped to this card: typing in the composer must not authorize a request.
        if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); choose(model.cancelOptionId) }
      }}>
      <div className="approval-body">
        <div className="permission-head"><Icon size={15} /><span>{agentName} · {category}</span></div>
        <div id={`${id}-title`} className="permission-title">{request.title || 'Allow this operation?'}</div>
        {details.reason && details.reason !== request.title && <p className="approval-reason">{details.reason}</p>}
        {details.command && <pre className="approval-command"><code>{details.command}</code></pre>}
        {details.cwd && <div className="approval-context"><span>Working directory</span><code>{details.cwd}</code></div>}
        {details.files.length > 0 && <div className="approval-files">{details.files.map((file, index) => (
          <details key={`${file.path}-${index}`} className="approval-file">
            <summary><IconFile size={14} /><span>{file.path}</span><span className="approval-detail-label">View changes</span></summary>
            {file.diff !== undefined ? <pre className="approval-diff"><code>{file.diff.split('\n').map((line, i) => (
              <span key={i} className={line.startsWith('+') ? 'is-addition' : line.startsWith('-') ? 'is-deletion' : undefined}>{line || ' '}{'\n'}</span>
            ))}</code></pre> : file.before !== undefined || file.after !== undefined ? <>
              {file.before !== undefined && <div className="approval-file-version"><span>Before</span><pre>{file.before}</pre></div>}
              {file.after !== undefined && <div className="approval-file-version"><span>After</span><pre>{file.after}</pre></div>}
            </> : <p className="approval-unavailable">The runtime did not provide a change preview.</p>}
          </details>
        ))}</div>}
        {details.kind === 'files' && !details.files.length && <p className="approval-unavailable">The runtime did not provide file details.</p>}
        {details.input != null && <details className="approval-input"><summary>Request details</summary><pre>{JSON.stringify(details.input, null, 2)}</pre></details>}
      </div>
      <fieldset className="approval-options" disabled={pending}>
        <legend className="sr-only">Choose permission scope</legend>
        {model.options.map(option => (
          <label key={option.id} className={`approval-option${selected === option.id ? ' is-selected' : ''}${option.kind === 'unsupported' ? ' is-disabled' : ''}`}>
            <input type="radio" name={`${id}-decision`} value={option.id} checked={selected === option.id}
              disabled={option.kind === 'unsupported'} onChange={() => setSelected(option.id)} />
            <span>{option.label}{typeof option._meta?.description === 'string' && <small>{option._meta.description}</small>}</span>
          </label>
        ))}
      </fieldset>
      <div className="approval-footer">
        <button type="button" className="approval-cancel" disabled={pending} onClick={() => choose(model.cancelOptionId)}>{model.cancelLabel}<kbd>Esc</kbd></button>
        <button type="submit" className="approval-submit" disabled={pending || !valid}>{pending ? 'Submitting…' : 'Submit'}</button>
      </div>
    </form>
  )
}
