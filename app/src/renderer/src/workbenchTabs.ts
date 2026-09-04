import type { ArtifactPreview, ProjectFilePreview } from '../../shared/protocol'

interface WorkbenchTabBase {
  key: string
  taskId: string
  label: string
}

export type WorkbenchTab =
  | (WorkbenchTabBase & { kind: 'artifact'; preview: ArtifactPreview })
  | (WorkbenchTabBase & { kind: 'project-file'; preview: ProjectFilePreview })

export interface WorkbenchState {
  tabs: WorkbenchTab[]
  activeByTask: Record<string, string | undefined>
}

export function emptyWorkbenchState(): WorkbenchState {
  return { tabs: [], activeByTask: {} }
}

export function projectFileTab(taskId: string, preview: ProjectFilePreview): WorkbenchTab {
  return {
    kind: 'project-file',
    key: `${taskId}:project-file:${preview.path}`,
    taskId,
    label: preview.name,
    preview,
  }
}

export function artifactTab(taskId: string, preview: ArtifactPreview): WorkbenchTab {
  return {
    kind: 'artifact',
    key: `${taskId}:artifact:${preview.path}`,
    taskId,
    label: preview.title ?? preview.name,
    preview,
  }
}

export function tabsForTask(state: WorkbenchState, taskId: string | null): WorkbenchTab[] {
  return taskId ? state.tabs.filter((tab) => tab.taskId === taskId) : []
}

export function activeTabForTask(
  state: WorkbenchState,
  taskId: string | null,
): WorkbenchTab | null {
  if (!taskId) return null
  const tabs = tabsForTask(state, taskId)
  const activeKey = state.activeByTask[taskId]
  return tabs.find((tab) => tab.key === activeKey) ?? tabs.at(-1) ?? null
}

export function openWorkbenchTab(
  state: WorkbenchState,
  tab: WorkbenchTab,
  activate = true,
): WorkbenchState {
  const index = state.tabs.findIndex((candidate) => candidate.key === tab.key)
  const tabs = index < 0
    ? [...state.tabs, tab]
    : state.tabs.map((candidate, candidateIndex) => candidateIndex === index ? tab : candidate)
  return {
    tabs,
    activeByTask: activate
      ? { ...state.activeByTask, [tab.taskId]: tab.key }
      : state.activeByTask,
  }
}

export function activateWorkbenchTab(state: WorkbenchState, key: string): WorkbenchState {
  const tab = state.tabs.find((candidate) => candidate.key === key)
  if (!tab) return state
  return {
    ...state,
    activeByTask: { ...state.activeByTask, [tab.taskId]: tab.key },
  }
}

export function closeWorkbenchTab(state: WorkbenchState, key: string): WorkbenchState {
  const index = state.tabs.findIndex((candidate) => candidate.key === key)
  if (index < 0) return state
  const closing = state.tabs[index]
  const tabs = state.tabs.filter((tab) => tab.key !== key)
  if (state.activeByTask[closing.taskId] !== key) return { ...state, tabs }

  const taskTabs = tabsForTask({ ...state, tabs }, closing.taskId)
  const next = taskTabs.find((tab) => state.tabs.indexOf(tab) > index)
    ?? taskTabs.findLast((tab) => state.tabs.indexOf(tab) < index)
  const activeByTask = { ...state.activeByTask }
  if (next) activeByTask[closing.taskId] = next.key
  else delete activeByTask[closing.taskId]
  return { tabs, activeByTask }
}

export function removeTaskWorkbenchTabs(state: WorkbenchState, taskIds: ReadonlySet<string>): WorkbenchState {
  const tabs = state.tabs.filter((tab) => !taskIds.has(tab.taskId))
  const activeByTask = Object.fromEntries(
    Object.entries(state.activeByTask).filter(([taskId]) => !taskIds.has(taskId)),
  )
  return { tabs, activeByTask }
}
