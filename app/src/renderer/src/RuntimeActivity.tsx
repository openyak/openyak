import type { Part } from '../../shared/protocol'
import { childAgents } from './runtimePresentation'

export function RuntimeActivity({ parts }: { parts: Part[] }) {
  const agents = childAgents(parts)
  const unknown = parts.filter(
    (p) =>
      p.type === 'event' &&
      (p.kind === 'provider.unknown' || p.kind === 'runtime.error'),
  )
  if (!agents.length && !unknown.length) return null
  return (
    <div className="runtime-activity">
      {agents.length > 0 && (
        <details className="runtime-agents">
          <summary>
            {agents.length} {agents.length === 1 ? 'agent' : 'agents'} ·{' '}
            {
              agents.filter((a) =>
                ['running', 'inProgress', 'in_progress', 'active'].includes(
                  a.status,
                ),
              ).length
            }{' '}
            running
          </summary>
          {agents.map((agent) => (
            <details key={agent.id} className="runtime-agent">
              <summary>
                <span>{agent.name}</span>
                <span className="runtime-agent-status">
                  {agent.status}
                  {agent.model ? ` · ${agent.model}` : ''}
                </span>
              </summary>
              <div className="runtime-agent-id">
                {agent.id}
                {agent.parentId ? ` ← ${agent.parentId}` : ''}
              </div>
              {agent.activities.length ? (
                <pre>{JSON.stringify(agent.activities, null, 2)}</pre>
              ) : (
                <p>No child activity reported yet.</p>
              )}
            </details>
          ))}
        </details>
      )}
      {unknown.length > 0 && (
        <details className="runtime-inspector">
          <summary>Additional agent activity ({unknown.length})</summary>
          <pre>{JSON.stringify(unknown, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}
