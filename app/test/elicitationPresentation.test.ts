import assert from 'node:assert/strict'
import test from 'node:test'
import type { FormElicitationRequest } from '../src/shared/protocol.ts'
import { elicitationFields } from '../src/renderer/src/elicitationPresentation.ts'

test('ACP AskUserQuestion schema is rendered without provider field-name knowledge', () => {
  const request: FormElicitationRequest = {
    request_id: 'request-1',
    task_id: 'task-1',
    agent: 'claude',
    mode: 'form',
    sessionId: 'session-1',
    message: 'Which direction should we take?',
    requestedSchema: {
      type: 'object',
      properties: {
        opaque_choice: {
          type: 'string',
          title: 'Direction',
          oneOf: [
            { const: 'A', title: 'First', description: 'Use the first path.' },
            { const: 'B', title: 'Second' },
          ],
        },
        opaque_other: { type: 'string', title: 'Other' },
      },
    },
  }

  assert.deepEqual(elicitationFields(request), [
    {
      key: 'opaque_choice',
      label: 'Direction',
      required: false,
      kind: 'single-select',
      choices: [
        { value: 'A', label: 'First', description: 'Use the first path.' },
        { value: 'B', label: 'Second' },
      ],
    },
    {
      key: 'opaque_other',
      label: 'Other',
      required: false,
      kind: 'text',
      choices: [],
    },
  ])
})

test('ACP arrays and primitive requirements keep their schema semantics', () => {
  const request: FormElicitationRequest = {
    request_id: 'request-2',
    task_id: 'task-1',
    agent: 'codex',
    mode: 'form',
    message: 'Configure the run',
    requestedSchema: {
      type: 'object',
      required: ['targets'],
      properties: {
        targets: {
          type: 'array',
          items: { anyOf: [{ const: 'web', title: 'Web' }, { const: 'app', title: 'App' }] },
        },
        retries: { type: 'integer', default: 2 },
        verbose: { type: 'boolean', default: false },
      },
    },
  }

  assert.deepEqual(
    elicitationFields(request).map(({ key, kind, required, defaultValue }) => ({
      key,
      kind,
      required,
      defaultValue,
    })),
    [
      { key: 'targets', kind: 'multi-select', required: true, defaultValue: undefined },
      { key: 'retries', kind: 'number', required: false, defaultValue: 2 },
      { key: 'verbose', kind: 'boolean', required: false, defaultValue: false },
    ],
  )
})
