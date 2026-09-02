import { useState } from 'react'
import type { Project, Task } from '../../shared/protocol'

interface Props {
  project: Project | null
  tasks: Task[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: (title: string) => void
}

export function TasksColumn({ project, tasks, selectedId, onSelect, onAdd }: Props) {
  const [draft, setDraft] = useState<string | null>(null)

  const submit = () => {
    const title = draft?.trim()
    if (title) onAdd(title)
    setDraft(null)
  }

  return (
    <section className="column column-tasks">
      <header className="column-header">
        <h2>{project ? `Tasks · ${project.name}` : 'Tasks'}</h2>
        <button onClick={() => setDraft('')} disabled={!project || draft !== null}>
          New task
        </button>
      </header>
      {draft !== null && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            autoFocus
            placeholder="Task title"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDraft(null)
            }}
            onBlur={() => {
              if (!draft?.trim()) setDraft(null)
            }}
          />
        </form>
      )}
      <ul className="list">
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              className={'list-item' + (t.id === selectedId ? ' selected' : '')}
              onClick={() => onSelect(t.id)}
            >
              <span className="list-title">{t.title}</span>
            </button>
          </li>
        ))}
        {project && tasks.length === 0 && draft === null && (
          <li className="empty">No tasks yet.</li>
        )}
        {!project && <li className="empty">Select a project.</li>}
      </ul>
    </section>
  )
}
