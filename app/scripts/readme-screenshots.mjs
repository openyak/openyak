// Real v2 screenshots with fictional data and fresh user data. Uses local Codex authentication.
/* global window, document, localStorage, matchMedia, console, process, setInterval, clearInterval */
import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'openyak-readme-'))
const workspace = join(directory, 'Orbit')
await cp(resolve('app/test/fixtures/readme'), workspace, { recursive: true })
const output = resolve('docs/images')
await mkdir(output, { recursive: true })
const dashboard = await readFile(join(workspace, 'dashboard.html'))
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(dashboard) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, OPENYAK_DATA_DIR: directory, OPENYAK_CORE_BIN: resolve('core/target/release/openyak-core') }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENYAK_AGENT_TRANSPORT']) delete env[key]
let app
let progress
const result = { directory, screenshots: [], errors: [] }
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [resolve('app')], env })
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), directory)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960))
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => result.errors.push(error.message))
  await page.getByPlaceholder('Do anything').waitFor()
  await page.evaluate(() => localStorage.setItem('openyak.providers.default', 'codex'))
  const project = await page.evaluate(path => window.openyak.request('project.create', { name: 'Orbit', path }), workspace)
  await page.reload()
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  // Playwright's default media emulation can override Electron nativeTheme.
  // Match the user's actual Dark setting rather than recoloring the app DOM.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches)
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Project: none', exact: true }).click()
  await page.getByRole('option', { name: 'Orbit', exact: true }).click()
  await page.getByRole('button', { name: /^Model and effort:/ }).waitFor()
  const capture = async name => {
    await page.mouse.move(8, 950)
    await page.screenshot({ path: join(output, name), scale: 'css' })
    result.screenshots.push(name)
  }
  let approving = false
  progress = setInterval(() => {
    if (approving) return
    approving = true
    void (async () => {
      await page.screenshot({ path: join(directory, 'progress.png'), scale: 'css' })
      const card = page.locator('.permission.elicitation')
      if (await card.count()) {
        const text = await card.innerText()
        if (/Allow the openyak_browser MCP server to run tool "browser_(navigate|snapshot|click)"\?/.test(text)) {
          await card.getByRole('button', { name: 'Submit', exact: true }).click()
        }
      }
      // Only accept this explicitly requested demo-file write, once. Never save a prefix rule.
      const commandCard = page.locator('.permission').filter({ hasText: 'Allow this command to run?' })
      if (await commandCard.count()) {
        const command = await commandCard.locator('pre').first().innerText()
        const match = command.match(/^\/bin\/zsh -lc "cat > release-report\.md <<'EOF'\n([\s\S]*)\nEOF\nwc -w release-report\.md"$/)
        if (match && !match[1].split('\n').includes('EOF') && (await commandCard.innerText()).includes(workspace)) {
          await commandCard.getByRole('radio', { name: 'Allow once', exact: true }).check()
          await commandCard.getByRole('button', { name: 'Submit', exact: true }).click()
        }
      }
    })().catch(() => {}).finally(() => { approving = false })
  }, 1000)
  const send = async text => {
    const before = await page.locator('.msg-assistant.status-done,.msg-assistant.status-error').count()
    await page.getByPlaceholder('Do anything').fill(text)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(n => document.querySelectorAll('.msg-assistant.status-done,.msg-assistant.status-error').length > n, before, { timeout: 180_000 })
    assert.equal(await page.locator('.msg-assistant.status-error').count(), 0)
  }
  console.log('README_CAPTURE', directory)
  await send("Review brief.md and write release-report.md: an executive summary, a metrics table and three next steps. Use only these fictional demo figures. Keep the report under 250 words. Do not browse the web or change other files. For the write, use exactly a quoted heredoc: cat > release-report.md <<'EOF', followed by the Markdown, then EOF on its own line, then wc -w release-report.md. In your reply, give a short release recommendation and clickable Markdown links to release-report.md and the existing dashboard.html.")
  await readFile(join(workspace, 'release-report.md'))
  const tasks = await page.evaluate(project_id => window.openyak.request('task.list', { project_id }), project.id)
  const task = tasks.find(task => task.project_id)
  assert.ok(task)
  await page.evaluate(task_id => window.openyak.request('task.rename', { task_id, title: 'Orbit launch review' }), task.id)
  await page.reload()
  await page.getByPlaceholder('Do anything').waitFor()
  await page.getByText('Orbit launch review', { exact: true }).click()
  const reportLink = page.locator('.msg-assistant .md-file-link').filter({ hasText: /report/i }).last()
  await reportLink.click()
  await page.getByRole('tab', { name: 'release-report.md', exact: true }).waitFor()
  await page.locator('.workbench-panel h1').waitFor()
  await capture('workbench-dark.png')
  await page.locator('.msg-assistant .md-file-link').filter({ hasText: /dashboard/i }).last().click()
  await page.getByRole('tab', { name: 'dashboard.html', exact: true }).waitFor()
  await page.locator('.workbench-panel iframe').waitFor()
  await page.frameLocator('.workbench-panel iframe').getByRole('heading', { name: 'A clearer path to launch.' }).waitFor()
  await capture('artifacts-dark.png')
  await page.getByRole('button', { name: 'Hide preview panel', exact: true }).click()
  await page.getByRole('button', { name: /^Model and effort:/ }).click()
  await page.getByTitle('Change model or agent').click()
  await page.locator('.mp-models').waitFor()
  await capture('providers-dark.png')
  await page.keyboard.press('Escape')
  await send(`Open the Orbit dashboard at http://127.0.0.1:${server.address().port}/ in the shared browser using only openyak_browser tools. Inspect it, click Mark reviewed, and confirm the visible result. Keep the page open. No external browser, shell, direct HTTP or evaluation.`)
  await page.locator('.browser-surface canvas').waitFor()
  await page.locator('.browser-empty').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await page.getByRole('button', { name: 'Resume agent', exact: true }).waitFor()
  await capture('browser-dark.png')
  assert.equal(result.errors.length, 0)
} catch (error) {
  result.errors.push(String(error)); process.exitCode = 1
  if (app) { const page = await app.firstWindow(); console.error((await page.locator('body').innerText()).slice(-4500)); await page.screenshot({ path: join(directory, 'failure.png') }) }
} finally {
  clearInterval(progress)
  await writeFile(join(directory, 'capture-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  await app?.close()
  server.closeAllConnections(); server.close()
}
