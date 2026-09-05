// Deterministic real Electron/Core regression. Uses only isolated fixture files/SQLite.
/* global window, localStorage */
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.OPENYAK_PLAYWRIGHT_MODULE || 'playwright')
const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'openyak-file-gui-'))
const env = { ...process.env, OPENYAK_DATA_DIR: directory, OPENYAK_CORE_BIN: process.env.OPENYAK_CORE_BIN || join(root, 'core/target/debug/openyak-core') }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.OPENYAK_AGENT_TRANSPORT
let app
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [join(root, 'app')], env })
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), directory)
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.getByPlaceholder('Do anything').waitFor()
  await page.evaluate(() => localStorage.setItem('openyak.providers.default', 'codex'))
  const request = (method, params) => page.evaluate(([method, params]) => window.openyak.request(method, params), [method, params])
  const projectless = await request('task.create', { title: 'Projectless file regression' })
  const cwd = (await request('task.context', { task_id: projectless.id })).cwd
  const projectRoot = join(directory, 'Project With Spaces')
  await mkdir(projectRoot)
  const project = await request('project.create', { name: 'Fixture project', path: projectRoot })
  const projectTask = await request('task.create', { title: 'Project file regression', project_id: project.id })
  assert.equal((await request('task.context', { task_id: projectTask.id })).cwd, projectRoot)
  const reportName = 'Mac_配置评估报告.md'
  const report = join(cwd, reportName)
  await writeFile(report, '# Rendered report\n\n| Item | Value |\n| --- | --- |\n| Test | OK |\n\n[Code](answer.ts:2)\n\n[HTML](preview.html)')
  await writeFile(join(cwd, 'answer.ts'), 'export const first = 1\nexport const second = 2\n')
  await writeFile(join(cwd, 'preview.html'), '<!doctype html><h1>Rendered HTML</h1><script>document.body.dataset.unsafe="yes"</script>')
  await writeFile(join(directory, 'outside.md'), '# Outside')
  await symlink(join(directory, 'outside.md'), join(cwd, 'escape.md'))
  await writeFile(join(projectRoot, 'REPORT.md'), '# Project report')

  // Legacy persisted Codex payload: no artifact or file.output event present.
  const changes = [{ path: report, kind: { type: 'add' }, diff: '+# Rendered report' }]
  const parts = [
    { type: 'tool_call', id: 'legacy-write', kind: 'edit', title: 'fileChange', status: 'completed', raw_output: { type: 'fileChange', status: 'completed', changes } },
    { type: 'event', kind: 'file_change.completed', data: { files: changes } },
    { type: 'text', text: `[下载 Mac 配置评估报告](${encodeURI(report)})\n\n[Missing](missing.md)\n\n[Outside](../outside.md)` },
  ]
  const db = new DatabaseSync(join(directory, 'openyak.db'))
  const insert = db.prepare('INSERT INTO messages(id,task_id,role,agent,parts,status,created_at) VALUES(?,?,?,?,?,?,?)')
  insert.run('legacy-report', projectless.id, 'assistant', 'codex', JSON.stringify(parts), 'done', new Date().toISOString())
  insert.run('project-report', projectTask.id, 'assistant', 'claude', JSON.stringify([{ type: 'text', text: '[Project report](REPORT.md)' }]), 'done', new Date().toISOString())
  db.close()
  await page.reload()
  console.log('Fixtures ready; verifying projectless auto-preview')
  await page.getByRole('button', { name: projectless.title, exact: true }).click()
  await page.locator('.workbench-markdown h1').filter({ hasText: 'Rendered report' }).waitFor()
  assert.equal(await page.locator('.workbench-markdown table').count(), 1)
  assert.equal(await page.locator('.artifact-chip').count(), 1)
  console.log('Auto-preview passed; verifying manual links and tabs')
  await page.getByRole('button', { name: `Close ${reportName}`, exact: true }).click()
  await page.locator('.workbench-panel').waitFor({ state: 'detached' })
  const link = page.getByRole('link', { name: '下载 Mac 配置评估报告', exact: true })
  assert.equal(await link.getAttribute('aria-disabled'), 'false')
  await link.click()
  await page.locator('.workbench-markdown h1').waitFor()
  await page.getByRole('link', { name: 'Code', exact: true }).click()
  await page.locator('.project-file-line.is-target[data-line="2"]').waitFor()
  assert.equal(await page.getByRole('tab').count(), 2)
  await page.getByRole('tab', { name: reportName, exact: true }).click()
  await page.getByRole('link', { name: 'HTML', exact: true }).click()
  await page.frameLocator('iframe[title="preview.html"]').getByRole('heading', { name: 'Rendered HTML' }).waitFor()
  assert.equal(await page.frameLocator('iframe[title="preview.html"]').locator('body').getAttribute('data-unsafe'), null)
  assert.equal(await page.getByRole('tab').count(), 3)
  await page.getByRole('link', { name: 'Missing', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'File is not available' }).waitFor()
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  const safety = await page.evaluate(async taskId => {
    const results = []
    for (const path of ['../outside.md', 'escape.md', 'missing.md']) {
      results.push(await window.openyak.resolveProjectFile(taskId, { path }))
    }
    try { await window.openyak.inspectProjectFile('/tmp', { path: 'outside.md' }); results.push('unsafe') }
    catch { results.push('rejected') }
    return results
  }, projectless.id)
  assert.deepEqual(safety, [null, null, null, 'rejected'])
  await page.getByRole('button', { name: projectTask.title, exact: true }).click()
  await page.getByRole('link', { name: 'Project report', exact: true }).click()
  await page.locator('.workbench-markdown h1').filter({ hasText: 'Project report' }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 1)
  await page.getByRole('button', { name: projectless.title, exact: true }).click()
  await page.getByRole('tab', { name: 'preview.html', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 3)
  await page.getByRole('tab', { name: reportName, exact: true }).click()
  assert.equal(errors.length, 0, errors.join('\n'))
  await page.screenshot({ path: join(directory, 'file-preview.png') })
  if (process.argv.includes('--live')) {
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await page.locator('.hero').waitFor()
    await page.getByPlaceholder('Do anything').fill('Create live-report.md in the current working directory using the file editing tool. Its entire content should be a Markdown heading: # Live file preview verified. Then reply with a Markdown link to the file. Do not run commands or access other files.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const completion = page.locator('.msg-assistant.status-done').filter({ hasText: 'live-report.md' })
    const first = await Promise.race([
      completion.waitFor({ timeout: 120000 }).then(() => 'done'),
      page.locator('.permission').waitFor({ timeout: 120000 }).then(() => 'permission'),
    ])
    if (first === 'permission') {
      // Authorize only this isolated test's requested write, never a persistent policy change.
      await page.locator('.permission').getByRole('radio', { name: 'Allow once', exact: true }).check()
      await page.locator('.permission').getByRole('button', { name: 'Submit', exact: true }).click()
    }
    await completion.waitFor({ timeout: 120000 })
    await page.locator('.workbench-markdown h1').filter({ hasText: 'Live file preview verified' }).waitFor()
    await page.getByRole('button', { name: 'Close live-report.md', exact: true }).click()
    await page.locator('.artifact-chip').filter({ hasText: 'live-report.md' }).click()
    await page.locator('.workbench-markdown h1').filter({ hasText: 'Live file preview verified' }).waitFor()
    await page.screenshot({ path: join(directory, 'live-preview.png') })
    console.log('Live Codex write → Core file.output → automatic preview → file card reopen passed')
  }
  console.log(JSON.stringify({ passed: true, directory, checks: ['legacy auto-preview', 'encoded report click', 'Markdown table', 'nested file links', 'syntax and line target', 'HTML sandbox', 'multiple tabs', 'visible missing-file error', 'traversal and symlink denial', 'task-scoped IPC', 'project context', 'task switching'] }))
} catch (error) {
  console.error(error)
  if (app) {
    const page = await app.firstWindow()
    console.error(await page.locator('body').innerText())
    await page.screenshot({ path: join(directory, 'failure.png') })
  }
  console.error(`Isolated diagnostics: ${directory}`)
  process.exitCode = 1
} finally {
  if (app) await app.close()
}
