import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  inlineFileReference,
  markdownFileReference,
} from '../src/renderer/src/fileReferencePresentation.ts'
import {
  inspectProjectFile,
  resolveProjectFile,
} from '../src/main/project-file-host.ts'

test('parses Markdown file destinations without hard-coding repository names', () => {
  assert.deepEqual(markdownFileReference('/Users/example/project/app/src/View.tsx:389'), {
    path: '/Users/example/project/app/src/View.tsx',
    line: 389,
  })
  assert.deepEqual(markdownFileReference('src/auth.js:17:4'), {
    path: 'src/auth.js',
    line: 17,
    column: 4,
  })
  assert.deepEqual(markdownFileReference('README.md#L8C2'), {
    path: 'README.md',
    line: 8,
    column: 2,
  })
  assert.deepEqual(markdownFileReference('file:///Users/example/My%20Project/main.rs#L12'), {
    path: '/Users/example/My Project/main.rs',
    line: 12,
  })
  assert.equal(markdownFileReference('https://example.com/file.ts'), null)
  assert.equal(markdownFileReference('#overview'), null)
})

test('inline code only offers path-shaped tokens to the authoritative project resolver', () => {
  assert.deepEqual(inlineFileReference('SUMMARY.md'), { path: 'SUMMARY.md' })
  assert.deepEqual(inlineFileReference('src/auth.js:42'), { path: 'src/auth.js', line: 42 })
  assert.deepEqual(inlineFileReference('.env'), { path: '.env' })
  assert.equal(inlineFileReference('npm run build'), null)
  // File names are not guessed from an extension allow-list. Existence is checked by the host.
  assert.deepEqual(inlineFileReference('Array.map'), { path: 'Array.map' })
  assert.equal(inlineFileReference('https://example.com'), null)
})

test('resolves only real files inside the active project, including symlink boundaries', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openyak-file-reference-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'project')
  const outside = path.join(directory, 'outside.txt')
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'answer.ts'), 'first\nsecond\nthird\n')
  await writeFile(outside, 'private')
  await symlink(outside, path.join(root, 'src', 'escape.txt'))

  const resolved = await resolveProjectFile(root, { path: 'src/answer.ts', line: 2 })
  assert.equal(resolved?.path, await realpath(path.join(root, 'src', 'answer.ts')))
  assert.equal(resolved?.relativePath, path.join('src', 'answer.ts'))
  assert.equal(resolved?.line, 2)
  assert.equal(await resolveProjectFile(root, { path: '../outside.txt' }), null)
  assert.equal(await resolveProjectFile(root, { path: 'src/escape.txt' }), null)
  assert.equal(await resolveProjectFile(root, { path: 'src/missing.ts' }), null)
})

test('builds a bounded text preview and preserves the requested location', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openyak-file-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'SUMMARY.md'), '# Summary\nDetails\n')

  const preview = await inspectProjectFile(root, { path: 'SUMMARY.md', line: 2, column: 3 })
  assert.equal(preview.name, 'SUMMARY.md')
  assert.equal(preview.content, '# Summary\nDetails\n')
  assert.equal(preview.line, 2)
  assert.equal(preview.column, 3)
  assert.equal(preview.truncated, false)
})
