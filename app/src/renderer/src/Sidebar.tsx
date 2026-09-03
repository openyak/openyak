import { useEffect, useState, type FormEvent } from 'react'
import type { Project, Task } from '../../shared/protocol'
import { Menu, type MenuEntry } from './Menu'
import {
  IconEdit,
  IconFolder,
  IconMore,
  IconPlus,
  IconSidebar,
  IconSort,
  IconTrash,
} from './icons'

type SortMode = 'recent' | 'name'
type Editing = { type: 'project' | 'task'; id: string; original: string; value: string }
type Confirming = { type: 'project' | 'task'; id: string; name: string }

const SORT_KEY = 'openyak.sidebar.sort'

function readSort(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent'
  } catch {
    return 'recent'
  }
}

interface Props {
  open: boolean
  onToggle: () => void
  projects: Project[]
  tasksByProject: Record<string, Task[]>
  workingTaskIds: ReadonlySet<string>
  selectedTaskId: string | null
  /** The selected chat has not started yet (or there is none). */
  draft: boolean
  /** Project the new chat lives in; highlighted while `draft`. */
  draftProjectId: string | null
  onNewChat: () => void
  onSelectTask: (id: string) => void
  onSelectProject: (id: string) => void
  onAddProject: () => void
  onRenameProject: (id: string, name: string) => Promise<void>
  onDeleteProject: (id: string) => Promise<void>
  onRenameTask: (id: string, title: string) => Promise<void>
  onDeleteTask: (id: string) => Promise<void>
}

export function Sidebar({
  open,
  onToggle,
  projects,
  tasksByProject,
  workingTaskIds,
  selectedTaskId,
  draft,
  draftProjectId,
  onNewChat,
  onSelectTask,
  onSelectProject,
  onAddProject,
  onRenameProject,
  onDeleteProject,
  onRenameTask,
  onDeleteTask,
}: Props) {
  const [sort, setSort] = useState<SortMode>(readSort)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) setConfirming(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [confirming, deleting])

  const chooseSort = (next: SortMode) => {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // Sorting is a local convenience; persistence is optional.
    }
  }

  const projectActivity = (project: Project) => {
    const latest = (tasksByProject[project.id] ?? []).reduce(
      (value, task) =>
        task.message_count > 0 && task.updated_at > value ? task.updated_at : value,
      '',
    )
    return latest || project.created_at
  }
  const orderedProjects = [...projects].sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : projectActivity(b).localeCompare(projectActivity(a)),
  )
  const orderedTasks = (projectId: string) =>
    [...(tasksByProject[projectId] ?? [])]
      .filter((task) => task.message_count > 0)
      .sort((a, b) =>
        sort === 'name'
          ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
          : b.updated_at.localeCompare(a.updated_at),
      )

  const startEdit = (type: Editing['type'], id: string, original: string) =>
    setEditing({ type, id, original, value: original })

  const commitEdit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!editing) return
    const current = editing
    const value = current.value.trim()
    setEditing(null)
    if (!value || value === current.original) return
    const rename =
      current.type === 'project'
        ? onRenameProject(current.id, value)
        : onRenameTask(current.id, value)
    void rename.catch(() => {})
  }

  const itemEntries = (type: Editing['type'], id: string, name: string): MenuEntry[] => [
    {
      id: 'rename',
      label: 'Rename',
      icon: <IconEdit size={14} />,
      onSelect: () => startEdit(type, id, name),
    },
    { separator: true },
    {
      id: 'delete',
      label: type === 'project' ? 'Delete project' : 'Delete chat',
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => setConfirming({ type, id, name }),
    },
  ]

  const confirmDelete = async () => {
    if (!confirming || deleting) return
    setDeleting(true)
    try {
      if (confirming.type === 'project') await onDeleteProject(confirming.id)
      else await onDeleteTask(confirming.id)
      setConfirming(null)
    } catch {
      // The app-level error toast carries the failure; keep the dialog open for retry.
    } finally {
      setDeleting(false)
    }
  }

  const renameField = (item: Editing) => (
    <form className="nav-rename" onSubmit={commitEdit}>
      <input
        autoFocus
        value={item.value}
        aria-label={item.type === 'project' ? 'Project name' : 'Chat name'}
        onChange={(event) => setEditing({ ...item, value: event.target.value })}
        onBlur={() => commitEdit()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setEditing(null)
          }
        }}
      />
    </form>
  )

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
            <div className="section-actions">
              <Menu
                plain
                side="bottom"
                align="end"
                className="sidebar-sort"
                triggerClassName="icon-btn small"
                trigger={<IconSort size={14} />}
                ariaLabel="Sort projects and chats"
                title={sort === 'recent' ? 'Sorted by recent activity' : 'Sorted by name'}
                entries={[
                  {
                    id: 'recent',
                    label: 'Recent activity',
                    checked: sort === 'recent',
                    onSelect: () => chooseSort('recent'),
                  },
                  {
                    id: 'name',
                    label: 'Name A–Z',
                    checked: sort === 'name',
                    onSelect: () => chooseSort('name'),
                  },
                ]}
              />
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
          </div>

          {orderedProjects.map((project) => (
            <div key={project.id} className="project">
              <div className="nav-row">
                {editing?.type === 'project' && editing.id === project.id ? (
                  renameField(editing)
                ) : (
                  <button
                    type="button"
                    className={`nav-item${draft && draftProjectId === project.id ? ' selected' : ''}`}
                    onClick={() => onSelectProject(project.id)}
                    title={project.path}
                  >
                    <IconFolder size={16} />
                    <span className="nav-label">{project.name}</span>
                  </button>
                )}
                {!(editing?.type === 'project' && editing.id === project.id) && (
                  <Menu
                    plain
                    side="bottom"
                    align="end"
                    className="nav-actions"
                    triggerClassName="nav-more"
                    trigger={<IconMore size={14} />}
                    ariaLabel={`Actions for project ${project.name}`}
                    title="Project actions"
                    entries={itemEntries('project', project.id, project.name)}
                  />
                )}
              </div>

              {orderedTasks(project.id).map((task) => (
                <div
                  key={task.id}
                  className={`nav-row nav-task-row${workingTaskIds.has(task.id) ? ' is-working' : ''}`}
                >
                  {editing?.type === 'task' && editing.id === task.id ? (
                    renameField(editing)
                  ) : (
                    <button
                      type="button"
                      className={`nav-item nav-task${task.id === selectedTaskId ? ' selected' : ''}`}
                      onClick={() => onSelectTask(task.id)}
                      title={task.title}
                    >
                      <span className="nav-label">{task.title}</span>
                    </button>
                  )}
                  {workingTaskIds.has(task.id) &&
                    !(editing?.type === 'task' && editing.id === task.id) && (
                      <span
                        className="nav-working"
                        role="status"
                        aria-label={`${task.title} is working`}
                      >
                        <span className="nav-working-spinner" />
                      </span>
                    )}
                  {!(editing?.type === 'task' && editing.id === task.id) && (
                    <Menu
                      plain
                      side="bottom"
                      align="end"
                      className="nav-actions"
                      triggerClassName="nav-more"
                      trigger={<IconMore size={14} />}
                      ariaLabel={`Actions for chat ${task.title}`}
                      title="Chat actions"
                      entries={itemEntries('task', task.id, task.title)}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}

          {projects.length === 0 && (
            <p className="sidebar-hint">Add a project: a folder for your agents to work in.</p>
          )}
        </div>

        {confirming && (
          <div className="confirm-backdrop" role="presentation" onMouseDown={() => setConfirming(null)}>
            <div
              className="confirm-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-title"
              aria-describedby="delete-description"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h2 id="delete-title">
                {confirming.type === 'project' ? 'Delete project?' : 'Delete chat?'}
              </h2>
              <p id="delete-description">
                {confirming.type === 'project'
                  ? `“${confirming.name}” and all of its chats will be removed from OpenYak. Files on disk stay unchanged.`
                  : `“${confirming.name}” and its conversation history will be removed.`}
              </p>
              <div className="confirm-actions">
                <button
                  autoFocus
                  type="button"
                  className="btn"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={deleting}
                  onClick={() => void confirmDelete()}
                >
                  {deleting
                    ? 'Deleting…'
                    : confirming.type === 'project'
                      ? 'Delete project'
                      : 'Delete chat'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
