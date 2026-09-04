import assert from 'node:assert/strict'
import test from 'node:test'
import type { Part } from '../src/shared/protocol.ts'
import {
  describeToolGroup,
  formatWorkDuration,
  groupWorkParts,
  isContextCompaction,
  normalizeThoughtText,
  partitionAssistantParts,
  shouldExposeToolOutput,
  shouldShowWorkStatus,
  summarizeWorkDetails,
  workNarrativeParts,
} from '../src/renderer/src/messagePresentation.ts'

const thought = (text: string): Part => ({ type: 'thought', text })
const text = (value: string): Part => ({ type: 'text', text: value })
const tool = (id: string, status: string): Part => ({
  type: 'tool_call',
  id,
  title: id,
  kind: 'execute',
  status,
})

const compaction = (status: string): Part => ({
  type: 'tool_call',
  id: `compaction-${status}`,
  title: 'Compact conversation',
  kind: 'think',
  status,
  _meta: { contextCompaction: {} },
})

test('streaming keeps only the current tool outside work details', () => {
  const previous = [thought('plan'), tool('first', 'completed'), thought('retry'), tool('second', 'failed')]
  const current = tool('third', 'in_progress')

  assert.deepEqual(partitionAssistantParts([...previous, current], true), {
    workParts: previous,
    visibleParts: [current],
  })
})

test('a completed tool stays visible until the next streaming activity arrives', () => {
  const plan = thought('plan')
  const completed = tool('inspect', 'completed')

  assert.deepEqual(partitionAssistantParts([plan, completed], true), {
    workParts: [plan],
    visibleParts: [completed],
  })
})

test('the latest thought remains the current streaming activity without exposing older work', () => {
  const completed = tool('inspect', 'completed')
  const currentThought = thought('checking the result')

  assert.deepEqual(partitionAssistantParts([completed, currentThought], true), {
    workParts: [completed],
    visibleParts: [currentThought],
  })
})

test('streaming final text collapses all completed work', () => {
  const work = [thought('plan'), tool('first', 'completed')]
  const answer = text('Final answer')

  assert.deepEqual(partitionAssistantParts([...work, answer], true), {
    workParts: work,
    visibleParts: [answer],
  })
})

test('an out-of-order active tool update remains the only visible tool', () => {
  const current = tool('parallel-a', 'in_progress')
  const completed = tool('parallel-b', 'completed')

  assert.deepEqual(partitionAssistantParts([thought('plan'), current, completed], true), {
    workParts: [thought('plan'), completed],
    visibleParts: [current],
  })
})

test('completed messages collapse everything through the last tool', () => {
  const work = [thought('plan'), tool('inspect', 'failed')]
  const answer = text('Recovered answer')

  assert.deepEqual(partitionAssistantParts([...work, answer], false), {
    workParts: work,
    visibleParts: [answer],
  })
})

test('trailing thought belongs to the single worked disclosure', () => {
  const first = thought('plan')
  const command = tool('inspect', 'completed')
  const finalThought = thought('summarize')
  const answer = text('Final answer')

  assert.deepEqual(partitionAssistantParts([first, command, finalThought, answer], false), {
    workParts: [first, command, finalThought],
    visibleParts: [answer],
  })
})

test('thought-only work is folded into worked instead of creating another disclosure', () => {
  const reasoning = thought('reasoning')
  const answer = text('Answer')

  assert.deepEqual(partitionAssistantParts([reasoning, answer], false), {
    workParts: [reasoning],
    visibleParts: [answer],
  })
})

test('thought content removes transport whitespace before Markdown rendering', () => {
  assert.equal(normalizeThoughtText('\n\n**Separating commands**\n\n'), '**Separating commands**')
})

test('expanded work keeps narrative parts but excludes tool output rows', () => {
  const commentary = text('Checking the project.')
  const reasoning = thought('Compare the two states.')

  assert.deepEqual(
    workNarrativeParts([commentary, tool('inspect', 'completed'), reasoning]),
    [commentary, reasoning],
  )
})

test('completed work summary reports elapsed time instead of step count', () => {
  assert.equal(summarizeWorkDetails(5 * 60_000, false), 'Worked for 5m')
  assert.equal(summarizeWorkDetails(4 * 60_000 + 15_000, false), 'Worked for 4m 15s')
})

test('streaming work summary reports live elapsed time', () => {
  assert.equal(summarizeWorkDetails(41_000, true), 'Working for 41s')
  assert.equal(formatWorkDuration(0), '<1s')
  assert.equal(formatWorkDuration(61_900), '1m 1s')
})

test('working timer is visible before the first tool or thought arrives', () => {
  assert.equal(shouldShowWorkStatus([], true), true)
  assert.equal(shouldShowWorkStatus([], false), false)
  assert.equal(shouldShowWorkStatus([tool('inspect', 'completed')], false), true)
})

test('work activity hides thoughts and commentary and groups matching tools across them', () => {
  const first = tool('read-a', 'completed')
  const second = tool('read-b', 'completed')
  const last = tool('run', 'completed')

  assert.deepEqual(groupWorkParts([thought('plan'), first, second, text('next'), last]), [
    { kind: 'execute', tools: [first, second, last], label: 'Ran 3 commands' },
  ])
})

test('different semantic activities stay as separate compact rows', () => {
  const readA: Part = { ...tool('Read Message.tsx', 'completed'), kind: 'read' }
  const readB: Part = { ...tool('Read styles.css', 'completed'), kind: 'read' }
  const search: Part = { ...tool('Search renderer', 'completed'), kind: 'search' }
  const run: Part = { ...tool('npm test', 'completed'), kind: 'execute' }

  assert.deepEqual(
    groupWorkParts([readA, thought('checking'), readB, text('still working'), search, run]),
    [
      { kind: 'read', tools: [readA, readB], label: 'Read 2 files' },
      { kind: 'search', tools: [search], label: 'Searched' },
      { kind: 'execute', tools: [run], label: 'Ran a command' },
    ],
  )
})

test('mixed activity groups use concise Codex-style summaries', () => {
  const readA: Part = { ...tool('Read Message.tsx', 'completed'), kind: 'read' }
  const readB: Part = { ...tool('Read styles.css', 'completed'), kind: 'read' }
  const run: Part = { ...tool('python3 check.py', 'completed'), kind: 'execute' }

  assert.equal(describeToolGroup([readA, readB, run]), 'Read 2 files, ran a command')
})

test('compaction is identified from ACP metadata instead of its display title', () => {
  const part: Part = {
    ...tool('opaque-title', 'in_progress'),
    title: 'Anything',
    kind: 'other',
    _meta: { contextCompaction: { trigger: 'automatic' } },
  }

  assert.equal(isContextCompaction(part), true)
})

test('compaction has dedicated in-progress and completed activity states', () => {
  const compacting = compaction('in_progress')
  const compacted = compaction('completed')

  assert.deepEqual(groupWorkParts([compacting, compacted]), [
    {
      kind: 'compaction',
      tools: [compacting],
      label: 'Context automatically compacting',
    },
    {
      kind: 'compaction',
      tools: [compacted],
      label: 'Context automatically compacted',
    },
  ])
})

test('compaction never exposes its internal summary as tool output', () => {
  const part = {
    ...compaction('completed'),
    output: 'private compacted conversation summary',
  } as Extract<Part, { type: 'tool_call' }>

  assert.equal(shouldExposeToolOutput(part), false)
})
