import type { PermissionRequest } from '../../shared/protocol'

interface Props {
  request: PermissionRequest
  onChoose: (optionId: string | null) => void
}

export function PermissionBar({ request, onChoose }: Props) {
  return (
    <div className="permission">
      <span className="badge">{request.agent}</span>
      <span className="permission-title">{request.title}</span>
      <div className="permission-options">
        {request.options.map((o) => (
          <button
            key={o.id}
            className={o.kind.startsWith('allow') ? 'primary' : ''}
            title={o.kind}
            onClick={() => onChoose(o.id)}
          >
            {o.label}
          </button>
        ))}
        <button className="linkish" onClick={() => onChoose(null)} title="Cancel the request">
          dismiss
        </button>
      </div>
    </div>
  )
}
