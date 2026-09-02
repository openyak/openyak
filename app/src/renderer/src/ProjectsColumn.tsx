import type { Project } from '../../shared/protocol'

interface Props {
  projects: Project[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
}

export function ProjectsColumn({ projects, selectedId, onSelect, onAdd }: Props) {
  return (
    <section className="column column-projects">
      <header className="column-header">
        <h2>Projects</h2>
        <button onClick={onAdd} title="Pick a directory">
          Add project
        </button>
      </header>
      <ul className="list">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              className={'list-item' + (p.id === selectedId ? ' selected' : '')}
              onClick={() => onSelect(p.id)}
              title={p.path}
            >
              <span className="list-title">{p.name}</span>
              <span className="list-sub">{p.path}</span>
            </button>
          </li>
        ))}
        {projects.length === 0 && <li className="empty">No projects yet.</li>}
      </ul>
    </section>
  )
}
