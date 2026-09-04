import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { taskFileRoot } from '../src/main/task-file-context.ts'
import { resolveProjectFile } from '../src/main/project-file-host.ts'
import { markdownFileReference } from '../src/renderer/src/fileReferencePresentation.ts'

test('projectless encoded report link resolves using task cwd, not a nullable project path', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openyak-task-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cwd = path.join(directory, 'Application Support', 'projectless')
  await mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'Mac_配置评估报告.md')
  await writeFile(file, '# Report')
  const root = await taskFileRoot('task-1', async (method, params) => {
    assert.equal(method, 'task.context')
    assert.deepEqual(params, { task_id: 'task-1' })
    return { task_id: 'task-1', cwd }
  })
  assert.equal((await resolveProjectFile(root, markdownFileReference(encodeURI(file))))?.name, 'Mac_配置评估报告.md')
  assert.equal(await resolveProjectFile(root, { path: '../outside.md' }), null)
})

test('invalid or mismatched task contexts never fall back to a broad directory', async () => {
  await assert.rejects(taskFileRoot(null, async () => ({})))
  await assert.rejects(taskFileRoot('a', async () => ({ task_id: 'b', cwd: '/tmp' })))
  await assert.rejects(taskFileRoot('a', async () => { throw new Error('unknown task_id') }), /unknown task_id/)
})
