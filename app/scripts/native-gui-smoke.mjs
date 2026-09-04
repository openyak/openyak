// Opt-in live Electron test. Requires Playwright and the built app/debug Core.
// OPENYAK_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
/* global localStorage, window */
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { _electron } = require(
  process.env.OPENYAK_PLAYWRIGHT_MODULE || 'playwright',
)
const directory = await mkdtemp(join(tmpdir(), 'openyak-native-gui-'))
const root = fileURLToPath(new URL('../../', import.meta.url))
const env = {
  ...process.env,
  OPENYAK_DATA_DIR: directory,
  OPENYAK_CORE_BIN: join(root, 'core/target/debug/openyak-core'),
}
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await _electron.launch({
    executablePath: require('electron'),
    args: [join(root, 'app')],
    env,
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.evaluate(() =>
    localStorage.setItem('openyak.providers.default', 'codex'),
  )
  await page.reload()
  await page.getByPlaceholder('Do anything').waitFor()
  console.log('initial', await page.locator('body').innerText())
  await page
    .getByPlaceholder('Do anything')
    .fill(
      'Reply with exactly: gui-native-ok. Do not use tools or modify files.',
    )
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page
    .locator('.msg-assistant.status-done')
    .filter({ hasText: 'gui-native-ok' })
    .waitFor({ timeout: 150000 })
  assert.equal(await page.getByText('Agent event log', { exact: true }).count(), 0)
  assert.equal(await page.locator('.runtime-log').count(), 0)
  const tasks = await page.evaluate(() =>
    window.openyak.request('task.list', {}),
  )
  const taskId = tasks[0].id
  // Deliberate IPC fixtures exercise renderer queueing independently of model choices.
  await app.evaluate(({ BrowserWindow }, taskId) => {
    const web = BrowserWindow.getAllWindows()[0].webContents
    for (const id of ['first', 'second'])
      web.send('core:elicitation-request', {
        key: id,
        params: {
          request_id: id,
          task_id: taskId,
          agent: 'codex',
          mode: 'form',
          message: `Fixture question ${id}`,
          requestedSchema: {
            type: 'object',
            properties: { answer: { type: 'string', title: 'Answer' } },
            required: ['answer'],
          },
        },
      })
  }, taskId)
  await page.getByText('Fixture question first', { exact: true }).waitFor()
  await page.locator('.elicitation-input').fill('First answer')
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.getByText('Fixture question second', { exact: true }).waitFor()
  assert.equal(
    await page.locator('.elicitation-input').inputValue(),
    '',
    'next question must start with an empty form',
  )
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.locator('.elicitation').waitFor({ state: 'detached' })
  await app.evaluate(({ BrowserWindow }, taskId) => {
    BrowserWindow.getAllWindows()[0].webContents.send('core:notification', {
      method: 'chat.event',
      params: {
        id: 'fixture-child',
        task_id: taskId,
        agent: 'codex',
        kind: 'agent.updated',
        created_at: new Date().toISOString(),
        data: {
          id: 'child',
          parentId: 'root',
          name: 'GUI fixture child',
          status: 'completed',
          activity: { note: 'Explicit test fixture, not a real subagent' },
        },
      },
    })
  }, taskId)
  await page.locator('.runtime-agents > summary').click()
  await page.getByText('GUI fixture child', { exact: true }).waitFor()
  assert.equal(errors.length, 0, errors.join('\n'))
  await page.screenshot({ path: join(directory, 'native-gui.png') })
  console.log(
    JSON.stringify({
      passed: true,
      screenshot: join(directory, 'native-gui.png'),
      text: await page.locator('body').innerText(),
    }),
  )
  // Preserve this explicit test directory so the screenshot can be inspected.
} catch (error) {
  console.error(error)
  process.exitCode = 1
  console.error(`Isolated diagnostic data: ${directory}`)
} finally {
  if (app) await app.close()
}
