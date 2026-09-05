/* global fetch, URL, setTimeout, console */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

await build({ entryPoints: ['app/src/main/browser-host.ts'], outfile: 'app/out/test/browser-host.cjs', bundle: true, platform: 'node', packages: 'external', format: 'cjs' })
const require = createRequire(import.meta.url)
const { BrowserHost } = require('../out/test/browser-host.cjs')
const cwd = await mkdtemp(join(tmpdir(), 'openyak-browser-host-'))
let latest
let frames = 0
let latestFrame
const host = new BrowserHost(state => { latest = state }, frame => { frames++; latestFrame = frame })
const waitFor = async predicate => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for a browser frame')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
const assertResolution = (width, height, ratio) => {
  assert.equal(latestFrame.mimeType, 'image/png', 'Text must use lossless frames')
  const png = Buffer.from(latestFrame.data, 'base64')
  assert.equal(png.readUInt32BE(16), Math.round(width * ratio), 'Actual pixel width must match display density')
  assert.equal(png.readUInt32BE(20), Math.round(height * ratio), 'Actual pixel height must match display density')
  assert.equal(latestFrame.width, width, 'Input coordinates stay in CSS pixels')
  assert.equal(latestFrame.height, height)
}
const fixture = createServer((_req, res) => res.end('<!doctype html><title>Shared browser test</title><h1>Browser acceptance</h1><button onclick="this.textContent=\'Clicked by agent\'">Click me</button><input aria-label="Shared input"><div style="height:1800px">Scroll area</div>'))
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const client = new Client({ name: 'acceptance', version: '1' })
try {
  await host.start()
  const env = host.environment()
  const url = `${env.OPENYAK_BROWSER_HOST}/session`
  assert.equal((await fetch(url, { method: 'POST' })).status, 403)
  const create = async taskId => (await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.OPENYAK_BROWSER_SECRET}` }, body: JSON.stringify({ taskId, cwd }) })).json()
  const session = await create('test-a')
  const other = await create('test-b')
  assert.notEqual(session.url, other.url)
  assert.equal((await fetch(session.url, { headers: { Origin: 'http://malicious.example' } })).status, 403)
  await client.connect(new StreamableHTTPClientTransport(new URL(session.url)))
  const tools = await client.listTools()
  assert.ok(tools.tools.some(tool => tool.name === 'browser_navigate'))
  const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${fixture.address().port}/` } })
  assert.ok(!navigation.isError, JSON.stringify(navigation))
  const state = host.list().find(state => state.taskId === 'test-a')
  const pageId = state.pages[0].id
  const snapshot = JSON.stringify(await client.callTool({ name: 'browser_snapshot', arguments: {} }))
  const ref = snapshot.match(/button \\"Click me\\" \[ref=(\w+)\]/)?.[1]
  assert.ok(ref, snapshot)
  const clicked = await client.callTool({ name: 'browser_click', arguments: { target: ref } })
  assert.ok(!clicked.isError, JSON.stringify(clicked))
  await host.command('test-a', { type: 'watch', pageId, width: 800, height: 600, deviceScaleFactor: 2 })
  await waitFor(() => frames > 0)
  assert.ok(frames > 0, 'CDP must stream real frames')
  assertResolution(800, 600, 2)
  await host.command('test-a', { type: 'takeover' })
  assert.equal(latest.control, 'user')
  const blocked = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } })
  assert.equal(blocked.isError, true)
  const beforeInput = frames
  await host.command('test-a', { type: 'key', pageId, key: 'Tab' })
  await host.command('test-a', { type: 'text', pageId, text: 'User and agent share this page' })
  await waitFor(() => frames > beforeInput)
  assertResolution(800, 600, 2)
  for (const ratio of [1, 1.5, 2]) {
    const beforeResize = frames
    await host.command('test-a', { type: 'watch', pageId, width: 640, height: 400, deviceScaleFactor: ratio })
    await waitFor(() => frames > beforeResize && latestFrame.width === 640)
    assertResolution(640, 400, ratio)
  }
  await host.command('test-a', { type: 'watch', pageId: null })
  const stopped = frames
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(frames, stopped, 'Detached sessions must not emit stale captures')
  await assert.rejects(host.command('test-b', { type: 'watch', pageId }), /closed/)
  await host.command('test-a', { type: 'resume' })
  const shared = await client.callTool({ name: 'browser_snapshot', arguments: {} })
  assert.match(JSON.stringify(shared), /User and agent share this page/)
  const closed = await client.callTool({ name: 'browser_close', arguments: {} })
  assert.ok(!closed.isError, JSON.stringify(closed))
  const reopened = await client.callTool({ name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${fixture.address().port}/` } })
  assert.ok(!reopened.isError, JSON.stringify(reopened))
  await host.forget('test-a')
  assert.equal((await fetch(session.url)).status, 404)
  console.log(JSON.stringify({ passed: true, tools: tools.tools.length, frames, sharedInput: true, crossTaskBlocked: true, pausedCallsBlocked: true }))
} finally {
  await client.close()
  await host.close()
  fixture.closeAllConnections(); fixture.close()
}
