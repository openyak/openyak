import assert from 'node:assert/strict'
import test from 'node:test'
import { fileOutputsFromParts } from '../src/renderer/src/fileOutputPresentation.ts'

test('file cards only consume common file output events, not prose or provider tool names', () => {
  assert.deepEqual(fileOutputsFromParts([
    { type: 'text', text: 'Wrote `fake.md`' },
    { type: 'event', kind: 'file_change.completed', data: { files: [{ path: 'raw.md' }] } },
    { type: 'event', kind: 'file.output', data: { schema_version: 1, tool_call_id: 'write', files: [{ path: 'report.md' }, null, { path: 3 }] } },
  ]), [{ key: 'file:write:2:report.md', kind: 'file', reference: { path: 'report.md' } }])
})

test('multiple writes refresh one file chip without mixing official Artifacts and file writes', () => {
  const outputs = fileOutputsFromParts(['a', 'b'].map(id => ({
    type: 'event', kind: 'file.output', data: { schema_version: 1, tool_call_id: id, files: [{ path: 'report.docx' }] },
  })))
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0].key, 'file:b:1:report.docx')
})
