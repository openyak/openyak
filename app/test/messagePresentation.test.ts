import assert from 'node:assert/strict'
import test from 'node:test'
import type { Part } from '../src/shared/protocol.ts'
import {
  buildWorkTimeline,
  cancelStreamingFrame,
  describeToolGroup,
  formatWorkDuration,
  isContextCompaction,
  hasActiveTool,
  initialStreamingText,
  partitionAssistantParts,
  shouldExposeToolOutput,
  shouldShowWorkStatus,
  splitStableStreamingText,
  streamingRevealStep,
  summarizeWorkDetails,
} from '../src/renderer/src/messagePresentation.ts'

const thought = (text: string): Part => ({ type: 'thought', text })
const text = (value: string): Part => ({ type: 'text', text: value })
const phasedText = (value: string, phase: string): Part => ({
  type: 'text',
  text: value,
  _meta: { codex: { phase } },
})
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

test('streaming keeps all accumulated temporary content visible until completion', () => {
  const commentary = text('Checking the system.')
  const previous = [thought('plan'), commentary, tool('first', 'completed'), thought('retry'), tool('second', 'failed')]
  const current = tool('third', 'in_progress')

  assert.deepEqual(partitionAssistantParts([...previous, current], true), {
    workParts: [],
    visibleParts: [commentary, previous[2], previous[4], current],
  })
})

test('a completed tool stays visible until the next streaming activity arrives', () => {
  const plan = thought('plan')
  const completed = tool('inspect', 'completed')

  assert.deepEqual(partitionAssistantParts([plan, completed], true), {
    workParts: [],
    visibleParts: [completed],
  })
})

test('a new thought does not hide earlier streaming activity', () => {
  const completed = tool('inspect', 'completed')
  const currentThought = thought('checking the result')

  assert.deepEqual(partitionAssistantParts([completed, currentThought], true), {
    workParts: [],
    visibleParts: [completed, currentThought],
  })
})

test('streaming final text keeps temporary work visible until chat.done', () => {
  const work = [thought('plan'), tool('first', 'completed')]
  const answer = text('Final answer')

  assert.deepEqual(partitionAssistantParts([...work, answer], true), {
    workParts: [],
    visibleParts: [work[1], answer],
  })
})

test('Codex final-answer phase moves prior streaming work into the disclosure immediately', () => {
  const commentary = phasedText('I will inspect the project.', 'commentary')
  const command = tool('inspect', 'completed')
  const answer = phasedText('Final answer', 'final_answer')

  assert.deepEqual(partitionAssistantParts([commentary, command, answer], true), {
    workParts: [commentary, command],
    visibleParts: [answer],
  })
})

test('out-of-order tool updates do not remove earlier streaming content', () => {
  const current = tool('parallel-a', 'in_progress')
  const completed = tool('parallel-b', 'completed')

  assert.deepEqual(partitionAssistantParts([thought('plan'), current, completed], true), {
    workParts: [],
    visibleParts: [current, completed],
  })
})

test('streaming exposes at most the currently active thought indicator', () => {
  const commentary = text('Inspecting the project.')
  const command = tool('inspect', 'completed')
  const currentThought = thought('preparing the next step')

  assert.deepEqual(
    partitionAssistantParts(
      [thought('initial plan'), commentary, thought('reading'), command, currentThought],
      true,
    ),
    {
      workParts: [],
      visibleParts: [commentary, command, currentThought],
    },
  )
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

test('reasoning summaries stay out of the Codex-style work timeline', () => {
  assert.deepEqual(buildWorkTimeline([thought('\n\n**Separating commands**\n\n')]), [])
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

test('expanded work preserves chronology and groups only adjacent tools', () => {
  const plan = thought('Planning inspection')
  const readA: Part = { ...tool('Read Message.tsx', 'completed'), kind: 'read' }
  const readB: Part = { ...tool('Read styles.css', 'completed'), kind: 'read' }
  const update = text('The first check is complete.')
  const run: Part = { ...tool('npm test', 'completed'), kind: 'execute' }

  assert.deepEqual(buildWorkTimeline([plan, readA, readB, update, run]), [
    {
      type: 'activity',
      activity: { kind: 'read', tools: [readA, readB], label: 'Read 2 files' },
      partIndex: 1,
    },
    { type: 'narrative', part: update, partIndex: 3 },
    {
      type: 'activity',
      activity: { kind: 'execute', tools: [run], label: 'Ran a command' },
      partIndex: 4,
    },
  ])
})

test('separated tools of the same kind do not jump across narrative updates', () => {
  const first: Part = { ...tool('Read first', 'completed'), kind: 'read' }
  const update = text('Now checking the second file.')
  const second: Part = { ...tool('Read second', 'completed'), kind: 'read' }

  const timeline = buildWorkTimeline([first, update, second])
  assert.deepEqual(
    timeline.map((entry) =>
      entry.type === 'activity' ? entry.activity.tools.map((item) => item.id) : entry.part.text,
    ),
    [['Read first'], 'Now checking the second file.', ['Read second']],
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

  assert.deepEqual(buildWorkTimeline([compacting, compacted]), [
    {
      type: 'activity',
      activity: {
        kind: 'compaction',
        tools: [compacting],
        label: 'Context automatically compacting',
      },
      partIndex: 0,
    },
    {
      type: 'activity',
      activity: {
        kind: 'compaction',
        tools: [compacted],
        label: 'Context automatically compacted',
      },
      partIndex: 1,
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

test('streaming reveal advances in bounded visual steps and catches up', () => {
  const target = 'abcdefghijklmnopqrstuvwxyz'.repeat(20)
  const first = streamingRevealStep('', target)
  assert.ok(first.length > 0)
  assert.ok(first.length < target.length)
  assert.ok(target.startsWith(first))

  let current = first
  for (let frame = 0; frame < 100 && current !== target; frame += 1) {
    current = streamingRevealStep(current, target)
  }
  assert.equal(current, target)
})

test('streaming Markdown stabilizes complete blocks but not unfinished code fences', () => {
  assert.deepEqual(splitStableStreamingText('First paragraph.\n\nStill typing'), {
    stable: 'First paragraph.\n\n',
    tail: 'Still typing',
  })
  assert.deepEqual(splitStableStreamingText('```ts\nconst value = 1\n\nmore'), {
    stable: '',
    tail: '```ts\nconst value = 1\n\nmore',
  })
})

test('a streaming text part starts from an empty visual buffer even after IPC batching', () => {
  const batchedFirstRender = 'A complete paragraph arrived before React committed.'
  assert.equal(initialStreamingText(batchedFirstRender, true), '')
  assert.equal(initialStreamingText(batchedFirstRender, false), batchedFirstRender)
})

test('cancelling a streaming frame releases the scheduler for Strict Mode effect replay', () => {
  const frame = { current: 42 as number | null }
  const cancelled: number[] = []

  cancelStreamingFrame(frame, (id) => cancelled.push(id))

  assert.deepEqual(cancelled, [42])
  assert.equal(frame.current, null)
})

test('an in-progress tool replaces the generic thinking indicator', () => {
  assert.equal(hasActiveTool([thought('planning')]), false)
  assert.equal(hasActiveTool([tool('inspect', 'completed')]), false)
  assert.equal(hasActiveTool([tool('inspect', 'in_progress')]), true)
  assert.equal(hasActiveTool([tool('inspect', 'pending')]), true)
})
