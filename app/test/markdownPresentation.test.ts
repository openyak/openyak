import assert from 'node:assert/strict'
import test from 'node:test'
import { codeBlockPresentation } from '../src/renderer/src/markdownPresentation.ts'
import {
  draggedScrollPosition,
  inlineDiagramMinWidth,
} from '../src/renderer/src/diagramPresentation.ts'

test('fenced code gets a readable language label', () => {
  assert.deepEqual(codeBlockPresentation('hljs language-ts'), {
    language: 'ts',
    label: 'TypeScript',
    diagram: false,
  })
  assert.deepEqual(codeBlockPresentation('language-python'), {
    language: 'python',
    label: 'Python',
    diagram: false,
  })
})

test('Mermaid fences are routed to the diagram renderer', () => {
  assert.deepEqual(codeBlockPresentation('hljs language-mermaid'), {
    language: 'mermaid',
    label: 'Mermaid',
    diagram: true,
  })
})

test('unlabelled fences retain a neutral code title', () => {
  assert.deepEqual(codeBlockPresentation(undefined), {
    language: null,
    label: 'Code',
    diagram: false,
  })
})

test('diagram drag translates pointer motion into bounded canvas scrolling', () => {
  assert.deepEqual(
    draggedScrollPosition(
      { left: 420, top: 260 },
      { x: 500, y: 400 },
      { x: 440, y: 350 },
    ),
    { left: 480, top: 310 },
  )

  assert.deepEqual(
    draggedScrollPosition(
      { left: 10, top: 8 },
      { x: 200, y: 120 },
      { x: 240, y: 160 },
    ),
    { left: 0, top: 0 },
  )
})

test('wide diagrams retain a readable inline scale instead of fitting the prose column', () => {
  assert.equal(inlineDiagramMinWidth('<svg viewBox="0 0 2400 700"></svg>'), 1872)
  assert.equal(inlineDiagramMinWidth('<svg viewBox="0 0 620 420"></svg>'), 720)
  assert.equal(inlineDiagramMinWidth('<svg></svg>'), 720)
})
