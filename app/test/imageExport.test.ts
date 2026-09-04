import assert from 'node:assert/strict'
import test from 'node:test'
import { saveImageAttachment } from '../src/main/save-image.ts'

const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('image export writes decoded bytes through the native save dialog', async () => {
  const writes: Array<{ path: string; data: Uint8Array }> = []
  const saved = await saveImageAttachment(
    { mimeType: 'image/png', data: onePixelPng, suggestedName: 'reference.png' },
    async (image) => {
      assert.equal(image.extension, 'png')
      assert.equal(image.suggestedName, 'reference.png')
      return { canceled: false, filePath: '/tmp/reference.png' }
    },
    async (path, data) => writes.push({ path, data }),
  )

  assert.equal(saved, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.path, '/tmp/reference.png')
  assert.equal(Buffer.from(writes[0]?.data ?? []).subarray(1, 4).toString(), 'PNG')
})

test('image export does not write after cancelling the save dialog', async () => {
  let writes = 0
  const saved = await saveImageAttachment(
    { mimeType: 'image/png', data: onePixelPng },
    async () => ({ canceled: true }),
    async () => {
      writes += 1
    },
  )

  assert.equal(saved, false)
  assert.equal(writes, 0)
})

test('image export rejects invalid payloads before opening the save dialog', async () => {
  let dialogs = 0
  await assert.rejects(
    saveImageAttachment(
      { mimeType: 'text/html', data: onePixelPng },
      async () => {
        dialogs += 1
        return { canceled: true }
      },
      async () => undefined,
    ),
    /Unsupported image type/,
  )
  await assert.rejects(
    saveImageAttachment(
      { mimeType: 'image/png', data: 'not base64' },
      async () => {
        dialogs += 1
        return { canceled: true }
      },
      async () => undefined,
    ),
    /valid base64/,
  )
  assert.equal(dialogs, 0)
})
