/* global process, console */
import { build } from 'esbuild'
import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'openyak-icons-'))
const fixturePath = resolve('app/out/test/desktop-icons.cjs')
await build({
  entryPoints: ['app/test/fixtures/desktop-icons-main.ts'], outfile: fixturePath,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  plugins: [{ name: 'test-native-assets', setup(build) {
    build.onResolve({ filter: /\?asset$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -6)), namespace: 'native-asset' }))
    build.onLoad({ filter: /.*/, namespace: 'native-asset' }, args => ({ contents: `export default ${JSON.stringify(args.path)}` }))
  } }],
})
const env = { ...process.env, OPENYAK_DATA_DIR: directory }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let application
try {
  application = await _electron.launch({ executablePath: require('electron'), args: [fixturePath], env })
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), directory)
  await application.firstWindow()
  const state = await application.evaluate((electron, file) => {
    const fixture = process.getBuiltinModule('module').createRequire(file)(file)
    const { desktop } = fixture
    return { icon: desktop.icon.getSize(), tray: desktop.trayImage.getSize(), scales: desktop.trayImage.getScaleFactors(),
      template: desktop.trayImage.isTemplateImage(), dockIconSet: fixture.dockIconSet,
      bounds: desktop.tray.getBounds(), menu: desktop.menu.items.map(item => item.label), name: electron.app.getName() }
  }, fixturePath)
  assert.deepEqual(state.icon, { width: 1024, height: 1024 })
  if (process.platform === 'darwin') {
    assert.equal(state.dockIconSet, true)
    assert.equal(state.template, true)
    assert.equal(state.tray.height, 18)
    assert.deepEqual(state.scales, [1, 2])
    assert.ok(state.bounds.width > 0 && state.bounds.height > 0, 'Real menu bar item must be installed')
  }
  assert.deepEqual(state.menu, ['Open OpenYak', '', 'Quit OpenYak'])
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  await application.evaluate((_, file) => { const { desktop } = process.getBuiltinModule('module').createRequire(file)(file); desktop.menu.items[0].click() }, fixturePath)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy())
  await application.evaluate((_, file) => { process.getBuiltinModule('module').createRequire(file)(file).desktop.tray.emit('click') }, fixturePath)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await application.evaluate((_, file) => { process.getBuiltinModule('module').createRequire(file)(file).desktop.dispose() }, fixturePath)
  assert.equal(await application.evaluate((_, file) => process.getBuiltinModule('module').createRequire(file)(file).desktop.tray.isDestroyed(), fixturePath), true)
  console.log(JSON.stringify({ passed: true, directory, ...state, openRestoresWindow: true, clickReopensWindow: true, cleanup: true }))
} finally { await application?.close() }

// Also launch the actual built v2 entrypoint: verifies bundled asset paths, not
// just the fixture's source imports. Never use the normal OpenYak data folder.
const appDirectory = await mkdtemp(join(tmpdir(), 'openyak-icons-app-'))
const realApp = await _electron.launch({ executablePath: require('electron'), args: [resolve('app')],
  env: { ...env, OPENYAK_DATA_DIR: appDirectory, OPENYAK_CORE_BIN: resolve('core/target/release/openyak-core') } })
try {
  assert.equal(await realApp.evaluate(({ app }) => app.getPath('userData')), appDirectory)
  const page = await realApp.firstWindow()
  await page.getByPlaceholder('Do anything').waitFor()
  await page.screenshot({ path: join(appDirectory, 'app.png') })
  console.log(JSON.stringify({ builtAppStarted: true, directory: appDirectory }))
} finally { await realApp.close() }
