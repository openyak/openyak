import assert from 'node:assert/strict'
import test from 'node:test'
import type { Part } from '../src/shared/protocol.ts'
import {
  hasToolRichContent,
  toolRichContent,
} from '../src/renderer/src/toolContentPresentation.ts'

type ToolPart = Extract<Part, { type: 'tool_call' }>

const tool = (overrides: Partial<ToolPart> = {}): ToolPart => ({
  type: 'tool_call',
  id: 'tool-1',
  title: 'Tool',
  kind: 'other',
  status: 'completed',
  ...overrides,
})

test('extracts ACP image generation content without relying on a tool name', () => {
  const content = toolRichContent(tool({
    content: [
      { type: 'content', content: { type: 'text', text: 'Revised prompt' } },
      { type: 'content', content: { type: 'image', data: 'cG5n', mimeType: 'image/png', uri: '/tmp/result.png' } },
    ],
  }))

  assert.deepEqual(content.texts, ['Revised prompt'])
  assert.deepEqual(content.images, [
    { data: 'cG5n', mimeType: 'image/png', uri: '/tmp/result.png' },
  ])
})

test('extracts MCP image, audio, and resource results from raw output', () => {
  const content = toolRichContent(tool({
    raw_output: {
      result: {
        content: [
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
          { type: 'resource_link', name: 'Report', uri: 'https://example.com/report' },
        ],
      },
      error: null,
    },
  }))

  assert.equal(content.images.length, 1)
  assert.equal(content.audio.length, 1)
  assert.deepEqual(content.resources, [
    { name: 'Report', uri: 'https://example.com/report', mimeType: null },
  ])
})

test('deduplicates content repeated in ACP and MCP envelopes', () => {
  const image = { type: 'image', data: 'c2FtZQ==', mimeType: 'image/png' }
  const part = tool({
    content: [{ type: 'content', content: image }],
    raw_output: { result: { content: [image] } },
  })

  assert.equal(toolRichContent(part).images.length, 1)
  assert.equal(hasToolRichContent(part), true)
  assert.equal(hasToolRichContent(tool()), false)
})
