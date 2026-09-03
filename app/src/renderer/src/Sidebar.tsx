import type { Project, Task } from '../../shared/protocol'
import { IconEdit, IconFolder, IconPlus, IconSidebar } from './icons'
import { timeAgo } from './format'

interface Props {
  open: boolean
  onToggle: () => void
  projects: Project[]
  tasksByProject: Record<string, Task[]>
  selectedTaskId: string | null
  /** The selected chat has not started yet (or there is none). */
  draft: boolean
  /** Project the new chat lives in; highlighted while `draft`. */
  draftProjectId: string | null
  onNewChat: () => void
  onSelectTask: (id: string) => void
  onSelectProject: (id: string) => void
  onAddProject: () => void
}

export function Sidebar({
  open,
  onToggle,
  projects,
  tasksByProject,
  selectedTaskId,
  draft,
  draftProjectId,
  onNewChat,
  onSelectTask,
  onSelectProject,
  onAddProject,
}: Props) {
  return (
    <aside className={`sidebar${open ? '' : ' collapsed'}`} aria-hidden={!open}>
      <div className="sidebar-inner">
        <div className="titlebar sidebar-titlebar">
          <button
            type="button"
            className="icon-btn no-drag"
            onClick={onToggle}
            title="Close sidebar"
            aria-label="Close sidebar"
            tabIndex={open ? 0 : -1}
          >
            <IconSidebar size={18} />
          </button>
        </div>

        <div className="sidebar-scroll">
          <div className="brand">OpenYak</div>

          <button
            type="button"
            className={`nav-item${draft && draftProjectId === null ? ' selected' : ''}`}
            onClick={onNewChat}
          >
            <IconEdit size={16} />
            <span className="nav-label">New chat</span>
          </button>

          <div className="section-head">
            <span>Projects</span>
            <button
              type="button"
              className="icon-btn small"
              onClick={onAddProject}
              title="Add project"
              aria-label="Add project"
            >
              <IconPlus size={14} />
            </button>
          </div>

          {projects.map((p) => (
            <div key={p.id} className="project">
              <button
                type="button"
                className={`nav-item${draft && draftProjectId === p.id ? ' selected' : ''}`}
                onClick={() => onSelectProject(p.id)}
                title={p.path}
              >
                <IconFolder size={16} />
                <span className="nav-label">{p.name}</span>
              </button>
              {/* A chat appears here once it has its first message. */}
              {(tasksByProject[p.id] ?? [])
                .filter((t) => t.message_count > 0)
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`nav-item nav-task${t.id === selectedTaskId ? ' selected' : ''}`}
                    onClick={() => onSelectTask(t.id)}
                    title={t.title}
                  >
                    <span className="nav-label">{t.title}</span>
                    <span className="nav-time">{timeAgo(t.updated_at)}</span>
                  </button>
                ))}
            </div>
          ))}

          {projects.length === 0 && (
            <p className="sidebar-hint">Add a project: a folder for your agents to work in.</p>
          )}
        </div>
      </div>
    </aside>
  )
}
