import assert from 'node:assert/strict'
import test from 'node:test'
import type { ArtifactPreview, ProjectFilePreview } from '../src/shared/protocol.ts'
import {
  activateWorkbenchTab,
  activeTabForTask,
  artifactTab,
  closeWorkbenchTab,
  emptyWorkbenchState,
  openWorkbenchTab,
  projectFileTab,
  tabsForTask,
} from '../src/renderer/src/workbenchTabs.ts'

function file(path: string): ProjectFilePreview {
  const name = path.split('/').at(-1) ?? path
  return {
    path: `/project/${path}`,
    relativePath: path,
    name,
    extension: name.split('.').at(-1) ?? '',
    size: 10,
    previewUrl: `openyak-project-file://preview/${path}`,
    content: 'const value = true',
    truncated: false,
  }
}

function artifact(path: string): ArtifactPreview {
  return {
    path: `/project/${path}`,
    name: path.split('/').at(-1) ?? path,
    extension: path.split('.').at(-1) ?? '',
    size: 12,
    previewUrl: `openyak-artifact://preview/${path}`,
    content: null,
    truncated: false,
  }
}

test('opening files creates real switchable tabs instead of replacing one slot', () => {
  const first = projectFileTab('task-1', file('SUMMARY.md'))
  const second = projectFileTab('task-1', file('src/server.js'))
  let state = openWorkbenchTab(emptyWorkbenchState(), first)
  state = openWorkbenchTab(state, second)

  assert.deepEqual(tabsForTask(state, 'task-1').map((tab) => tab.label), [
    'SUMMARY.md',
    'server.js',
  ])
  assert.equal(state.activeByTask['task-1'], second.key)

  state = activateWorkbenchTab(state, first.key)
  assert.equal(state.activeByTask['task-1'], first.key)

  state = closeWorkbenchTab(state, first.key)
  assert.deepEqual(tabsForTask(state, 'task-1').map((tab) => tab.label), ['server.js'])
  assert.equal(state.activeByTask['task-1'], second.key)
})

test('a slower earlier open may add its tab without stealing focus from the latest click', () => {
  const first = projectFileTab('task-1', file('README.md'))
  const second = projectFileTab('task-1', file('src/auth.js'))
  let state = openWorkbenchTab(emptyWorkbenchState(), second)
  state = openWorkbenchTab(state, first, false)

  assert.equal(state.activeByTask['task-1'], second.key)
  assert.equal(tabsForTask(state, 'task-1').length, 2)
})

test('artifact and project files share tabs while each task keeps its own selection', () => {
  const project = projectFileTab('task-1', file('README.md'))
  const generated = artifactTab('task-1', artifact('report.pdf'))
  const anotherTask = projectFileTab('task-2', file('src/index.ts'))
  let state = openWorkbenchTab(emptyWorkbenchState(), project)
  state = openWorkbenchTab(state, generated)
  state = openWorkbenchTab(state, anotherTask)

  assert.deepEqual(tabsForTask(state, 'task-1').map((tab) => tab.kind), [
    'project-file',
    'artifact',
  ])
  assert.equal(activeTabForTask(state, 'task-1')?.key, generated.key)
  assert.equal(activeTabForTask(state, 'task-2')?.key, anotherTask.key)

  state = openWorkbenchTab(state, artifactTab('task-1', { ...generated.preview, size: 24 }))
  assert.equal(tabsForTask(state, 'task-1').length, 2)
  assert.equal(activeTabForTask(state, 'task-1')?.preview.size, 24)
})
