// Real Codex + Electron, always in an isolated user-data directory.
/* global window, document, localStorage, console, process, setInterval, clearInterval */
import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'openyak-live-browser-'))
const env = { ...process.env, OPENYAK_DATA_DIR: directory, OPENYAK_CORE_BIN: resolve('core/target/release/openyak-core') }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENYAK_AGENT_TRANSPORT']) delete env[key]
let clicks = 0
const fixture = createServer((req, res) => {
  if (req.url === '/clicked') { clicks++; res.end('VERIFIED'); return }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><html><head><title>OpenYak · shared browser</title><style>body{font:16px system-ui;padding:48px;background:#f6f7f9;color:#172330}small{color:#657788}button,input{font:inherit;padding:12px 18px;border:1px solid #bbc5cc;border-radius:8px}button{background:#172330;color:white}input{display:block;margin:24px 0;width:75%}</style></head><body><small>OPENYAK / LIVE BROWSER TEST</small><h1>One browser. Shared control.</h1><p>Agent actions and user input use the same page.</p><button onclick="fetch('/clicked').then(()=>this.textContent='VERIFIED')">Verify shared browser</button><input aria-label="Handoff message" placeholder="Type after taking control"><p style="margin-top:900px">Bottom of the test page</p></body></html>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
let app
let progress
const result = { directory, clicks: 0, errors: [], checks: {} }
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [resolve('app')], env })
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), directory)
  await app.evaluate(({ BrowserWindow, nativeTheme }) => { nativeTheme.themeSource = 'dark'; BrowserWindow.getAllWindows()[0].setContentSize(1440, 900) })
  const page = await app.firstWindow()
  let approving = false
  progress = setInterval(() => {
    if (approving) return
    approving = true
    void (async () => {
      await page.screenshot({ path: join(directory, 'progress.png') })
      const card = page.locator('.permission.elicitation')
      if (await card.count()) {
        const text = await card.innerText()
        // Explicitly authorized test only, never permanent/session-wide grants.
        if (/Allow the openyak_browser MCP server to run tool "browser_(navigate|snapshot|click)"\?/.test(text))
          await card.getByRole('button', { name: 'Submit', exact: true }).click()
      }
    })().catch(() => {}).finally(() => { approving = false })
  }, 1000)
  page.on('pageerror', error => result.errors.push(error.message))
  page.setDefaultTimeout(20_000)
  await page.getByPlaceholder('Do anything').waitFor()
  await page.evaluate(() => { localStorage.setItem('openyak.providers.default', 'codex'); localStorage.setItem('openyak.theme', 'dark') })
  await page.reload()
  const send = async text => {
    const count = await page.locator('.msg-assistant.status-done,.msg-assistant.status-error').count()
    await page.getByPlaceholder('Do anything').fill(text)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(n => document.querySelectorAll('.msg-assistant.status-done,.msg-assistant.status-error').length > n, count, { timeout: 180_000 })
  }
  console.log('ISOLATED_APP', directory)
  await send(`Authorized test of OpenYak's integrated browser. Use ONLY the openyak_browser MCP server to navigate to http://127.0.0.1:${fixture.address().port}/, take a browser_snapshot and click the button Verify shared browser. Report the resulting button text. Keep this page open. No shell, files, external browsers, computer-use plugins, direct HTTP or evaluation. If that MCP server is unavailable report its error, do not use an alternative.`)
  result.clicks = clicks
  const tasks = await page.evaluate(() => window.openyak.request('task.list', {}))
  const taskId = tasks[0].id
  const history = await page.evaluate(task_id => window.openyak.request('chat.history', { task_id }), taskId)
  result.checks.firstReply = history.at(-1)
  assert.equal(clicks, 1, 'Real Codex must click the shared browser page')
  await page.getByRole('button', { name: 'Take control', exact: true }).waitFor()
  await page.waitForFunction(() => { const canvas = document.querySelector('.browser-surface canvas'); return canvas && canvas.width > 320 && !document.querySelector('.browser-empty') })
  result.checks.displayResolution = await page.locator('.browser-surface canvas').evaluate(canvas => ({
    pixels: [canvas.width, canvas.height],
    css: [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)],
    density: window.devicePixelRatio,
  }))
  const { pixels, css, density } = result.checks.displayResolution
  assert.deepEqual(pixels, css.map(size => Math.round(size * Math.max(1, Math.min(3, density)))), 'Canvas must contain actual display-density pixels')
  await page.screenshot({ path: join(directory, '01-agent-browser.png') })
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await page.getByRole('button', { name: 'Resume agent', exact: true }).waitFor()
  // Real pointer and keyboard events through the rendered OpenYak canvas.
  await page.locator('.browser-surface canvas').click({ position: { x: 125, y: 280 } })
  await page.keyboard.type('USER_HANDOFF_73')
  await page.screenshot({ path: join(directory, '02-user-takeover.png') })
  await page.getByRole('button', { name: 'Resume agent', exact: true }).click()
  await send('Using only openyak_browser browser_snapshot on the current existing tab, report the exact current value of Handoff message. Do not type or change it. No other tools.')
  const nextHistory = await page.evaluate(task_id => window.openyak.request('chat.history', { task_id }), taskId)
  result.checks.handoffReply = nextHistory.at(-1)
  assert.match(JSON.stringify(nextHistory.at(-1)), /USER_HANDOFF_73/)
  await page.screenshot({ path: join(directory, '03-agent-resumed.png') })
  result.checks.samePageHandoff = true
  // Multiple genuine pages, not replaced preview tabs.
  await page.getByRole('button', { name: 'New browser tab', exact: true }).click()
  await page.getByRole('tab', { name: 'New tab', exact: true }).waitFor()
  result.checks.tabs = await page.getByRole('tab').count()
  assert.equal(result.checks.tabs, 2)
  await page.getByRole('tab', { name: 'OpenYak · shared browser', exact: true }).click()
  await page.getByRole('button', { name: 'Resume agent', exact: true }).waitFor()
  await page.locator('.browser-empty').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(directory, '04-multiple-tabs.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(850, 720))
  await page.getByRole('button', { name: 'Hide preview panel', exact: true }).click()
  await page.getByPlaceholder('Do anything').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await page.getByRole('tab', { name: 'OpenYak · shared browser', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2)
  await page.locator('.browser-empty').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(directory, '05-narrow-browser.png') })
  result.checks.narrowHideRestore = true
  assert.equal(result.errors.length, 0)
} catch (error) {
  result.errors.push(String(error)); process.exitCode = 1
  if (app) {
    const page = await app.firstWindow()
    await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {})
    console.error((await page.locator('body').innerText()).slice(-6000))
  }
} finally {
  clearInterval(progress)
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2))
  console.log('RESULT', JSON.stringify(result))
  if (app) await app.close()
  fixture.closeAllConnections(); fixture.close()
}
