import assert from 'node:assert/strict'
import test from 'node:test'
import {
  codePreviewLanguage,
  filePreviewKind,
} from '../src/renderer/src/filePreviewPresentation.ts'

test('routes rendered document formats to their native preview', () => {
  assert.equal(filePreviewKind('md', true, false), 'markdown')
  assert.equal(filePreviewKind('MARKDOWN', true, false), 'markdown')
  assert.equal(filePreviewKind('html', true, false), 'html')
  assert.equal(filePreviewKind('pdf', false, false), 'pdf')
  assert.equal(filePreviewKind('docx', false, true), 'docx')
  assert.equal(filePreviewKind('png', false, false), 'image')
})

test('falls back to source only for text and rejects unknown binary files', () => {
  assert.equal(filePreviewKind('ts', true, false), 'source')
  assert.equal(filePreviewKind('zip', false, false), 'unsupported')
  assert.equal(filePreviewKind('docx', false, false), 'unsupported')
})

test('maps filename extensions onto syntax grammars without provider-specific rules', () => {
  assert.equal(codePreviewLanguage('TS'), 'typescript')
  assert.equal(codePreviewLanguage('py'), 'python')
  assert.equal(codePreviewLanguage('rs'), 'rust')
  assert.equal(codePreviewLanguage(''), 'plain')
})
