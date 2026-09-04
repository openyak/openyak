import assert from 'node:assert/strict'
import test from 'node:test'
import { saveDiagramSvg } from '../src/main/save-diagram.ts'

test('diagram export writes the SVG selected by the native save dialog', async () => {
  const writes: Array<{ path: string; data: string }> = []
  const saved = await saveDiagramSvg(
    '<svg><text>OpenYak</text></svg>',
    async () => ({ canceled: false, filePath: '/tmp/architecture.svg' }),
    async (path, data) => {
      writes.push({ path, data })
    },
  )

  assert.equal(saved, true)
  assert.deepEqual(writes, [
    { path: '/tmp/architecture.svg', data: '<svg><text>OpenYak</text></svg>' },
  ])
})

test('diagram export does not write when the save dialog is cancelled', async () => {
  let writes = 0
  const saved = await saveDiagramSvg(
    '<svg />',
    async () => ({ canceled: true }),
    async () => {
      writes += 1
    },
  )

  assert.equal(saved, false)
  assert.equal(writes, 0)
})

test('diagram export rejects non-SVG payloads at the IPC boundary', async () => {
  await assert.rejects(
    saveDiagramSvg('not an image', async () => ({ canceled: true }), async () => undefined),
    /valid SVG/,
  )
})
