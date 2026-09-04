import assert from 'node:assert/strict'
import test from 'node:test'
import { codeBlockPresentation } from '../src/renderer/src/markdownPresentation.ts'
import {
  diagramOverflows,
  diagramViewBoxSize,
  draggedScrollPosition,
  inlineDiagramStyle,
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

test('inline diagrams use their natural viewBox without growing beyond the container', () => {
  const wide = '<svg viewBox="0 0 2400 700"></svg>'
  assert.deepEqual(diagramViewBoxSize(wide), { width: 2400, height: 700 })
  assert.deepEqual(inlineDiagramStyle(wide), { width: '2400px', maxWidth: '100%' })
  assert.deepEqual(inlineDiagramStyle('<svg></svg>'), { width: 'auto', maxWidth: '100%' })
})

test('intrinsic Mermaid overflow is detected independently of its fitted display width', () => {
  assert.equal(diagramOverflows(2400, 1180), true)
  assert.equal(diagramOverflows(620, 1180), false)
  assert.equal(diagramOverflows(1180, 1180), false)
})
