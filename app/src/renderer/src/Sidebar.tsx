import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { Project, Task } from '../../shared/protocol'
import { ContextMenu, Menu, type MenuEntry } from './Menu'
import {
  IconChat,
  IconChevronRight,
  IconClose,
  IconEdit,
  IconDesktop,
  IconFolder,
  IconMore,
  IconPlus,
  IconSidebar,
  IconSettings,
  IconSort,
  IconTrash,
} from './icons'

type SortMode = 'recent' | 'name'
type ChatRenameEditor = { id: string; original: string; name: string; saving: boolean }
type Confirming = { type: 'project' | 'task'; id: string; name: string }
type ProjectEditor = { project: Project; name: string; path: string; saving: boolean }
type ItemContextMenu = {
  type: 'project' | 'task'
  id: string
  name: string
  x: number
  y: number
  keyboard: boolean
}
type SidebarPreviewContent =
  | { kind: 'task'; task: Task; project: Project | null }
  | { kind: 'project'; project: Project; taskCount: number; activeCount: number }
type SidebarPreview = SidebarPreviewContent & { left: number; top: number }

const SORT_KEY = 'openyak.sidebar.sort'
const PROJECTLESS_TASKS = '__projectless'
const COLLAPSED_PROJECTS_KEY = 'openyak.sidebar.collapsed-projects'
const SIDEBAR_WIDTH_KEY = 'openyak.sidebar.width'
const SIDEBAR_DEFAULT_WIDTH = 260
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 480
const isMac = navigator.platform.startsWith('Mac')

function clampSidebarWidth(value: number) {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(value)))
}

function readSidebarWidth() {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(value) && value > 0
      ? clampSidebarWidth(value)
      : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

function readCollapsedProjects() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

function readSort(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent'
  } catch {
    return 'recent'
  }
}

function relativeTime(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  )
}

function compactPath(value: string) {
  return value
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~')
}

function folderName(value: string) {
  const parts = value.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || value
}

interface Props {
  open: boolean
  onToggle: () => void
  settingsOpen: boolean
  onOpenSettings: () => void
  onBackToApp: () => void
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
  onAddProject: () => void
  onUpdateProject: (id: string, name: string, path: string) => Promise<void>
  onDeleteProject: (id: string) => Promise<void>
  onRenameTask: (id: string, title: string) => Promise<void>
  onDeleteTask: (id: string) => Promise<void>
}

export function Sidebar({
  open,
  onToggle,
  settingsOpen,
  onOpenSettings,
  onBackToApp,
  projects,
  tasksByProject,
  workingTaskIds,
  selectedTaskId,
  draft,
  draftProjectId,
  onNewChat,
  onSelectTask,
  onAddProject,
  onUpdateProject,
  onDeleteProject,
  onRenameTask,
  onDeleteTask,
}: Props) {
  const [sort, setSort] = useState<SortMode>(readSort)
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsedProjects)
  const [chatRename, setChatRename] = useState<ChatRenameEditor | null>(null)
  const [projectEditor, setProjectEditor] = useState<ProjectEditor | null>(null)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [resizing, setResizing] = useState(false)
  const [itemContextMenu, setItemContextMenu] = useState<ItemContextMenu | null>(null)
  const [sidebarPreview, setSidebarPreview] = useState<SidebarPreview | null>(null)
  const previewTimer = useRef<number | null>(null)
  const previewHideTimer = useRef<number | null>(null)
  const sidebarWidthRef = useRef(sidebarWidth)
  const sidebarResizeRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)

  const clearPreviewTimer = useCallback(() => {
    if (previewTimer.current === null) return
    window.clearTimeout(previewTimer.current)
    previewTimer.current = null
  }, [])

  const clearPreviewHideTimer = useCallback(() => {
    if (previewHideTimer.current === null) return
    window.clearTimeout(previewHideTimer.current)
    previewHideTimer.current = null
  }, [])

  const hideSidebarPreview = useCallback(() => {
    clearPreviewTimer()
    clearPreviewHideTimer()
    setSidebarPreview(null)
  }, [clearPreviewHideTimer, clearPreviewTimer])

  const updateSidebarWidth = (value: number) => {
    const next = clampSidebarWidth(value)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
    return next
  }

  const persistSidebarWidth = (value: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value))
    } catch {
      // Resizing remains functional when local persistence is unavailable.
    }
  }

  const finishSidebarResize = () => {
    if (!sidebarResizeRef.current) return
    sidebarResizeRef.current = null
    setResizing(false)
    document.body.classList.remove('sidebar-resize-active')
    persistSidebarWidth(sidebarWidthRef.current)
  }

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    hideSidebarPreview()
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidthRef.current,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('sidebar-resize-active')
    setResizing(true)
  }

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = sidebarResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    updateSidebarWidth(resize.startWidth + event.clientX - resize.startX)
  }

  const resizeSidebarFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = sidebarWidthRef.current - step
    if (event.key === 'ArrowRight') next = sidebarWidthRef.current + step
    if (event.key === 'Home') next = SIDEBAR_MIN_WIDTH
    if (event.key === 'End') next = SIDEBAR_MAX_WIDTH
    if (next === null) return
    event.preventDefault()
    persistSidebarWidth(updateSidebarWidth(next))
  }

  const schedulePreviewHide = useCallback(
    (delay: number) => {
      clearPreviewTimer()
      clearPreviewHideTimer()
      previewHideTimer.current = window.setTimeout(() => {
        previewHideTimer.current = null
        setSidebarPreview(null)
      }, delay)
    },
    [clearPreviewHideTimer, clearPreviewTimer],
  )

  const showSidebarPreview = useCallback(
    (
      anchor: HTMLButtonElement,
      content: SidebarPreviewContent,
      delay: number,
      estimatedHeight: number,
    ) => {
      clearPreviewTimer()
      clearPreviewHideTimer()
      const rect = anchor.getBoundingClientRect()
      const preview = {
        ...content,
        left: Math.max(
          8,
          Math.min(rect.right + (content.kind === 'project' ? 6 : 8), window.innerWidth - 328),
        ),
        top: Math.max(8, Math.min(rect.top - 1, window.innerHeight - estimatedHeight - 8)),
      }
      if (delay === 0) {
        setSidebarPreview(preview)
        return
      }
      previewTimer.current = window.setTimeout(() => {
        previewTimer.current = null
        setSidebarPreview(preview)
      }, delay)
    },
    [clearPreviewHideTimer, clearPreviewTimer],
  )

  useEffect(() => {
    if (!confirming && !projectEditor && !chatRename) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (confirming && !deleting) setConfirming(null)
      else if (projectEditor && !projectEditor.saving) setProjectEditor(null)
      else if (chatRename && !chatRename.saving) setChatRename(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [chatRename, confirming, deleting, projectEditor])

  useEffect(() => {
    const dismiss = () => hideSidebarPreview()
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('resize', dismiss)
      clearPreviewTimer()
      clearPreviewHideTimer()
    }
  }, [clearPreviewHideTimer, clearPreviewTimer, hideSidebarPreview])

  useEffect(
    () => () => {
      document.body.classList.remove('sidebar-resize-active')
    },
    [],
  )

  const chooseSort = (next: SortMode) => {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // Sorting is a local convenience; persistence is optional.
    }
  }

  const toggleProject = (projectId: string) => {
    hideSidebarPreview()
    setCollapsedProjects((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      try {
        localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next]))
      } catch {
        // Collapsing remains functional when local persistence is unavailable.
      }
      return next
    })
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
  const projectlessTasks = orderedTasks(PROJECTLESS_TASKS)

  const closeItemContextMenu = useCallback(() => setItemContextMenu(null), [])

  const openChatRename = (id: string, original: string) => {
    hideSidebarPreview()
    closeItemContextMenu()
    setChatRename({ id, original, name: original, saving: false })
  }

  const openProjectEditor = (project: Project) => {
    hideSidebarPreview()
    closeItemContextMenu()
    setProjectEditor({ project, name: project.name, path: project.path, saving: false })
  }

  const openItemContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    type: ItemContextMenu['type'],
    id: string,
    original: string,
  ) => {
    if ((event.target as HTMLElement).closest('input, textarea')) return
    event.preventDefault()
    event.stopPropagation()
    hideSidebarPreview()
    setItemContextMenu({
      type,
      id,
      name: original,
      x: event.clientX,
      y: event.clientY,
      keyboard: false,
    })
  }

  const openKeyboardItemMenu = (
    event: ReactKeyboardEvent<HTMLElement>,
    type: ItemContextMenu['type'],
    id: string,
    original: string,
  ) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    event.stopPropagation()
    hideSidebarPreview()
    const rect = event.currentTarget.getBoundingClientRect()
    setItemContextMenu({
      type,
      id,
      name: original,
      x: rect.right - 8,
      y: rect.top + 8,
      keyboard: true,
    })
  }

  const itemEntries = (type: ItemContextMenu['type'], id: string, name: string): MenuEntry[] => [
    {
      id: 'rename',
      label: type === 'project' ? 'Edit' : 'Rename',
      icon: <IconEdit size={14} />,
      onSelect: () => {
        if (type === 'project') {
          const project = projects.find((candidate) => candidate.id === id)
          if (project) openProjectEditor(project)
        } else {
          openChatRename(id, name)
        }
      },
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
      if (confirming.type === 'project' && projectEditor?.project.id === confirming.id) {
        setProjectEditor(null)
      }
      setConfirming(null)
    } catch {
      // The app-level error toast carries the failure; keep the dialog open for retry.
    } finally {
      setDeleting(false)
    }
  }

  const closeProjectEditor = () => {
    if (!projectEditor?.saving) setProjectEditor(null)
  }

  const closeChatRename = () => {
    if (!chatRename?.saving) setChatRename(null)
  }

  const saveChatRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!chatRename || chatRename.saving) return
    const name = chatRename.name.trim()
    if (!name) return
    if (name === chatRename.original) {
      setChatRename(null)
      return
    }
    setChatRename((current) => (current ? { ...current, saving: true } : current))
    try {
      await onRenameTask(chatRename.id, name)
      setChatRename(null)
    } catch {
      setChatRename((current) => (current ? { ...current, saving: false } : current))
    }
  }

  const chooseProjectFolder = async () => {
    if (!projectEditor || projectEditor.saving) return
    const path = await window.openyak.pickDirectory()
    if (path) setProjectEditor((current) => (current ? { ...current, path } : current))
  }

  const saveProject = async (event: FormEvent) => {
    event.preventDefault()
    if (!projectEditor || projectEditor.saving) return
    const name = projectEditor.name.trim()
    const path = projectEditor.path.trim()
    if (!name || !path) return
    if (name === projectEditor.project.name && path === projectEditor.project.path) {
      setProjectEditor(null)
      return
    }
    setProjectEditor((current) => (current ? { ...current, saving: true } : current))
    try {
      await onUpdateProject(projectEditor.project.id, name, path)
      setProjectEditor(null)
    } catch {
      setProjectEditor((current) => (current ? { ...current, saving: false } : current))
    }
  }

  return (
    <aside
      className={`sidebar${open ? '' : ' collapsed'}${resizing ? ' resizing' : ''}`}
      aria-hidden={!open}
      style={{ '--sidebar': `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="sidebar-inner">
        <div
          className={`titlebar sidebar-titlebar${isMac ? ' with-traffic-lights' : ''}`}
        >
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

        <div
          className={`sidebar-scroll${settingsOpen ? ' sidebar-settings-navigation' : ''}`}
          onScroll={hideSidebarPreview}
        >
          {settingsOpen ? (
            <button
              type="button"
              className="nav-item sidebar-back-to-app"
              data-tooltip-ignore="true"
              onClick={() => {
                hideSidebarPreview()
                onBackToApp()
              }}
            >
              <IconChevronRight size={16} className="sidebar-back-icon" />
              <span className="nav-label">Back to app</span>
            </button>
          ) : (
            <>
              <div className="sidebar-brand-row">
                <div className="brand">OpenYak</div>
                <button
                  type="button"
                  className="icon-btn sidebar-settings-trigger"
                  onClick={() => {
                    hideSidebarPreview()
                    onOpenSettings()
                  }}
                  title="Settings"
                  aria-label="Open settings"
                >
                  <IconSettings size={16} />
                </button>
              </div>

              <button
                type="button"
                className={`nav-item${draft && draftProjectId === null ? ' selected' : ''}`}
                data-tooltip-ignore="true"
                onClick={onNewChat}
              >
                <IconEdit size={16} />
                <span className="nav-label">New chat</span>
              </button>

          {projectlessTasks.length > 0 && (
            <>
              <div className="section-head">
                <span>Recents</span>
              </div>
              {projectlessTasks.map((task) => (
                <div
                  key={task.id}
                  className={`nav-row nav-task-row projectless-task${workingTaskIds.has(task.id) ? ' is-working' : ''}`}
                  onContextMenu={(event) =>
                    openItemContextMenu(event, 'task', task.id, task.title)
                  }
                >
                  <button
                    type="button"
                    className={`nav-item${task.id === selectedTaskId ? ' selected' : ''}`}
                    data-tooltip-ignore="true"
                    onClick={() => {
                      hideSidebarPreview()
                      onSelectTask(task.id)
                    }}
                    onMouseEnter={(event) =>
                      showSidebarPreview(
                        event.currentTarget,
                        { kind: 'task', task, project: null },
                        360,
                        76,
                      )
                    }
                    onMouseLeave={hideSidebarPreview}
                    onFocus={(event) =>
                      showSidebarPreview(
                        event.currentTarget,
                        { kind: 'task', task, project: null },
                        0,
                        76,
                      )
                    }
                    onBlur={hideSidebarPreview}
                    onKeyDown={(event) =>
                      openKeyboardItemMenu(event, 'task', task.id, task.title)
                    }
                    aria-describedby={
                      sidebarPreview?.kind === 'task' && sidebarPreview.task.id === task.id
                        ? 'sidebar-task-preview'
                        : undefined
                    }
                  >
                    <span className="nav-label">{task.title}</span>
                  </button>
                  {workingTaskIds.has(task.id) && (
                    <span
                      className="nav-working"
                      role="status"
                      aria-label={`${task.title} is working`}
                    >
                      <span className="nav-working-spinner" />
                    </span>
                  )}
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
                      compact
                      onOpenChange={(isOpen) => {
                        if (!isOpen) return
                        hideSidebarPreview()
                        closeItemContextMenu()
                      }}
                    />
                </div>
              ))}
            </>
          )}

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
            <div
              key={project.id}
              className={`project${collapsedProjects.has(project.id) ? ' is-collapsed' : ''}`}
            >
              <div
                className="nav-row"
                onContextMenu={(event) =>
                  openItemContextMenu(event, 'project', project.id, project.name)
                }
              >
                <button
                  type="button"
                  className={`nav-item${draft && draftProjectId === project.id ? ' selected' : ''}`}
                  data-tooltip-ignore="true"
                  aria-expanded={!collapsedProjects.has(project.id)}
                  aria-controls={`project-tasks-${project.id}${
                    sidebarPreview?.kind === 'project' && sidebarPreview.project.id === project.id
                      ? ' sidebar-project-preview'
                      : ''
                  }`}
                  onClick={() => toggleProject(project.id)}
                  onMouseEnter={(event) => {
                    const tasks = orderedTasks(project.id)
                    showSidebarPreview(
                      event.currentTarget,
                      {
                        kind: 'project',
                        project,
                        taskCount: tasks.length,
                        activeCount: tasks.filter((task) => workingTaskIds.has(task.id)).length,
                      },
                      360,
                      142,
                    )
                  }}
                  onMouseLeave={() => schedulePreviewHide(120)}
                  onFocus={(event) => {
                    const tasks = orderedTasks(project.id)
                    showSidebarPreview(
                      event.currentTarget,
                      {
                        kind: 'project',
                        project,
                        taskCount: tasks.length,
                        activeCount: tasks.filter((task) => workingTaskIds.has(task.id)).length,
                      },
                      0,
                      142,
                    )
                  }}
                  onBlur={() => schedulePreviewHide(120)}
                  onKeyDown={(event) =>
                    openKeyboardItemMenu(event, 'project', project.id, project.name)
                  }
                >
                  <IconFolder size={16} />
                  <span className="nav-label">{project.name}</span>
                </button>
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
                    compact
                    onOpenChange={(isOpen) => {
                      if (!isOpen) return
                      hideSidebarPreview()
                      closeItemContextMenu()
                    }}
                  />
              </div>

              <div
                id={`project-tasks-${project.id}`}
                className="project-tasks-shell"
                aria-hidden={collapsedProjects.has(project.id)}
                inert={collapsedProjects.has(project.id) ? true : undefined}
              >
                <div className="project-tasks-inner">
                  {orderedTasks(project.id).map((task) => (
                    <div
                      key={task.id}
                      className={`nav-row nav-task-row${workingTaskIds.has(task.id) ? ' is-working' : ''}`}
                      onContextMenu={(event) =>
                        openItemContextMenu(event, 'task', task.id, task.title)
                      }
                    >
                      <button
                        type="button"
                        className={`nav-item nav-task${task.id === selectedTaskId ? ' selected' : ''}`}
                        data-tooltip-ignore="true"
                        onClick={() => {
                          hideSidebarPreview()
                          onSelectTask(task.id)
                        }}
                        onMouseEnter={(event) =>
                          showSidebarPreview(
                            event.currentTarget,
                            { kind: 'task', task, project },
                            360,
                            76,
                          )
                        }
                        onMouseLeave={hideSidebarPreview}
                        onFocus={(event) =>
                          showSidebarPreview(
                            event.currentTarget,
                            { kind: 'task', task, project },
                            0,
                            76,
                          )
                        }
                        onBlur={hideSidebarPreview}
                        onKeyDown={(event) =>
                          openKeyboardItemMenu(event, 'task', task.id, task.title)
                        }
                        aria-describedby={
                          sidebarPreview?.kind === 'task' && sidebarPreview.task.id === task.id
                            ? 'sidebar-task-preview'
                            : undefined
                        }
                      >
                        <span className="nav-label">{task.title}</span>
                      </button>
                      {workingTaskIds.has(task.id) && (
                        <span
                          className="nav-working"
                          role="status"
                          aria-label={`${task.title} is working`}
                        >
                          <span className="nav-working-spinner" />
                        </span>
                      )}
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
                          compact
                          onOpenChange={(isOpen) => {
                            if (!isOpen) return
                            hideSidebarPreview()
                            closeItemContextMenu()
                          }}
                        />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}

              {projects.length === 0 && (
                <p className="sidebar-hint">
                  Projects are optional. Add one to give agents a folder.
                </p>
              )}
            </>
          )}
        </div>

        {itemContextMenu && (
          <ContextMenu
            entries={itemEntries(
              itemContextMenu.type,
              itemContextMenu.id,
              itemContextMenu.name,
            )}
            x={itemContextMenu.x}
            y={itemContextMenu.y}
            compact
            autoFocus={itemContextMenu.keyboard}
            className="nav-context-menu"
            onClose={closeItemContextMenu}
          />
        )}

        {sidebarPreview?.kind === 'task' &&
          createPortal(
            <div
              id="sidebar-task-preview"
              className="nav-task-preview"
              role="tooltip"
              style={{ left: sidebarPreview.left, top: sidebarPreview.top }}
            >
              <div className="nav-task-preview-title-row">
                <span className="nav-task-preview-title">{sidebarPreview.task.title}</span>
                <IconDesktop size={15} />
                <time dateTime={sidebarPreview.task.updated_at}>
                  {relativeTime(sidebarPreview.task.updated_at)}
                </time>
              </div>
              <div className="nav-task-preview-project">
                <IconFolder size={15} />
                <span>{sidebarPreview.project?.name ?? 'No project'}</span>
              </div>
            </div>,
            document.body,
          )}

        {sidebarPreview?.kind === 'project' &&
          createPortal(
            <div
              id="sidebar-project-preview"
              className="nav-project-preview"
              role="group"
              aria-label={`Project details for ${sidebarPreview.project.name}`}
              style={{ left: sidebarPreview.left, top: sidebarPreview.top }}
              onMouseEnter={clearPreviewHideTimer}
              onMouseLeave={hideSidebarPreview}
            >
              <div className="nav-project-preview-heading">
                <IconFolder size={18} />
                <strong>{sidebarPreview.project.name}</strong>
              </div>
              <div className="nav-project-preview-stat">
                <IconChat size={16} />
                <span>
                  {sidebarPreview.taskCount} {sidebarPreview.taskCount === 1 ? 'task' : 'tasks'} ·{' '}
                  {sidebarPreview.activeCount} active
                </span>
              </div>
              <div className="nav-project-preview-separator" />
              <div className="nav-project-preview-path" title={sidebarPreview.project.path}>
                <IconFolder size={16} />
                <span>{compactPath(sidebarPreview.project.path)}</span>
              </div>
              <div className="nav-project-preview-separator" />
              <button
                type="button"
                className="nav-project-preview-edit"
                data-tooltip-ignore="true"
                onClick={() => openProjectEditor(sidebarPreview.project)}
              >
                <IconSettings size={17} />
                <span>Edit project</span>
              </button>
            </div>,
            document.body,
          )}

        {chatRename &&
          createPortal(
            <div className="editor-backdrop" role="presentation" onMouseDown={closeChatRename}>
              <form
                className="editor-modal chat-rename"
                role="dialog"
                aria-modal="true"
                aria-labelledby="chat-rename-title"
                aria-describedby="chat-rename-description"
                onSubmit={(event) => void saveChatRename(event)}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <header className="editor-header">
                  <h2 id="chat-rename-title">Rename chat</h2>
                  <button
                    type="button"
                    className="editor-close"
                    aria-label="Close rename chat"
                    disabled={chatRename.saving}
                    onClick={closeChatRename}
                  >
                    <IconClose size={17} />
                  </button>
                </header>
                <p id="chat-rename-description" className="chat-rename-description">
                  Keep it short and recognizable
                </p>
                <input
                  autoFocus
                  className="chat-rename-input"
                  value={chatRename.name}
                  aria-label="Chat name"
                  disabled={chatRename.saving}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) =>
                    setChatRename((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                />
                <footer className="editor-footer chat-rename-footer">
                  <div className="editor-actions">
                    <button
                      type="button"
                      className="editor-cancel chat-rename-cancel"
                      data-tooltip-ignore="true"
                      disabled={chatRename.saving}
                      onClick={closeChatRename}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="editor-save"
                      data-tooltip-ignore="true"
                      disabled={chatRename.saving || !chatRename.name.trim()}
                    >
                      {chatRename.saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </footer>
              </form>
            </div>,
            document.body,
          )}

        {projectEditor &&
          createPortal(
            <div
              className="editor-backdrop"
              role="presentation"
              onMouseDown={closeProjectEditor}
            >
              <form
                className="editor-modal project-editor"
                role="dialog"
                aria-modal="true"
                aria-labelledby="project-editor-title"
                onSubmit={(event) => void saveProject(event)}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <header className="editor-header">
                  <h2 id="project-editor-title">Edit project</h2>
                  <button
                    type="button"
                    className="editor-close"
                    aria-label="Close project editor"
                    disabled={projectEditor.saving}
                    onClick={closeProjectEditor}
                  >
                    <IconClose size={17} />
                  </button>
                </header>

                <label className="project-editor-name">
                  <span className="project-editor-name-icon">
                    <IconFolder size={17} />
                  </span>
                  <input
                    autoFocus
                    value={projectEditor.name}
                    aria-label="Project name"
                    disabled={projectEditor.saving}
                    onChange={(event) =>
                      setProjectEditor((current) =>
                        current ? { ...current, name: event.target.value } : current,
                      )
                    }
                  />
                </label>

                <div className="project-editor-section-title">Source folder</div>
                <div className="project-editor-sources">
                  {projectEditor.path && (
                    <div className="project-editor-source" title={projectEditor.path}>
                      <IconFolder size={17} />
                      <span>{folderName(projectEditor.path)}</span>
                      <button
                        type="button"
                        className="project-editor-remove-folder"
                        aria-label="Remove source folder"
                        disabled={projectEditor.saving}
                        onClick={() =>
                          setProjectEditor((current) =>
                            current ? { ...current, path: '' } : current,
                          )
                        }
                      >
                        <IconClose size={14} />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="project-editor-add-folder"
                    data-tooltip-ignore="true"
                    disabled={projectEditor.saving}
                    onClick={() => void chooseProjectFolder()}
                  >
                    <span className="project-editor-add-icon" aria-hidden="true">
                      <IconFolder size={17} />
                      <IconPlus size={10} />
                    </span>
                    <span>Add folder</span>
                  </button>
                </div>

                <footer className="editor-footer project-editor-footer">
                  <button
                    type="button"
                    className="project-editor-remove"
                    data-tooltip-ignore="true"
                    disabled={projectEditor.saving}
                    onClick={() =>
                      setConfirming({
                        type: 'project',
                        id: projectEditor.project.id,
                        name: projectEditor.name.trim() || projectEditor.project.name,
                      })
                    }
                  >
                    Remove local project
                  </button>
                  <div className="editor-actions">
                    <button
                      type="button"
                      className="editor-cancel"
                      data-tooltip-ignore="true"
                      disabled={projectEditor.saving}
                      onClick={closeProjectEditor}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="editor-save"
                      data-tooltip-ignore="true"
                      disabled={
                        projectEditor.saving ||
                        !projectEditor.name.trim() ||
                        !projectEditor.path.trim()
                      }
                    >
                      {projectEditor.saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </footer>
              </form>
            </div>,
            document.body,
          )}

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
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        aria-valuetext={`${sidebarWidth} pixels`}
        tabIndex={open ? 0 : -1}
        onPointerDown={beginSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          finishSidebarResize()
        }}
        onPointerCancel={finishSidebarResize}
        onLostPointerCapture={finishSidebarResize}
        onKeyDown={resizeSidebarFromKeyboard}
        onDoubleClick={() => {
          persistSidebarWidth(updateSidebarWidth(SIDEBAR_DEFAULT_WIDTH))
        }}
      />
    </aside>
  )
}
