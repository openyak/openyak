import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserControl, browserUrl } from '../src/main/browser-control.ts'

test('takeover drains work and refuses new calls until explicit resume', async () => {
  const gate = new BrowserControl(() => {})
  let finish!: () => void
  const pending = gate.run(() => new Promise<void>(resolve => { finish = resolve }))
  await Promise.resolve()
  gate.takeOver()
  assert.equal(gate.mode, 'taking-over')
  assert.throws(() => gate.requireUser())
  assert.throws(() => gate.resume())
  await assert.rejects(gate.run(async () => {}))
  finish(); await pending
  assert.equal(gate.mode, 'user')
  gate.requireUser()
  await assert.rejects(gate.run(async () => {}))
  gate.resume()
  assert.equal(await gate.run(async () => 42), 42)
})
test('queued agent actions do not run after takeover', async () => {
  const gate = new BrowserControl(() => {})
  let finish!: () => void
  const first = gate.run(() => new Promise<void>(resolve => { finish = resolve }))
  await Promise.resolve()
  let ran = false
  const second = gate.run(async () => { ran = true })
  gate.takeOver()
  finish(); await first
  await assert.rejects(second)
  assert.equal(ran, false)
})
test('browser navigation refuses local files, custom protocols and embedded credentials', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'openyak-artifact://a', 'https://user:secret@example.com']) assert.throws(() => browserUrl(value))
  assert.equal(browserUrl('https://example.com'), 'https://example.com/')
})
