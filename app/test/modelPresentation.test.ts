import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentConfigOption } from '../src/shared/protocol.ts'
import {
  displayedCurrentModel,
  displayedModelChoices,
} from '../src/renderer/src/modelPresentation.ts'

type SelectOption = Extract<AgentConfigOption, { type: 'select' }>

const claudeModels: SelectOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  current_value: 'default',
  options: [
    { value: 'default', name: 'Default (recommended)', description: 'Opus (1M context)' },
    { value: 'opus[1m]', name: 'Opus (1M context)' },
    { value: 'sonnet', name: 'Sonnet' },
  ],
}

test('Claude model choices omit the redundant provider-default alias', () => {
  assert.deepEqual(
    displayedModelChoices('claude', claudeModels).map((choice) => choice.value),
    ['opus[1m]', 'sonnet'],
  )
  assert.equal(displayedCurrentModel('claude', claudeModels)?.value, 'opus[1m]')
})

test('other providers retain their advertised default choice', () => {
  assert.deepEqual(
    displayedModelChoices('codex', claudeModels).map((choice) => choice.value),
    ['default', 'opus[1m]', 'sonnet'],
  )
  assert.equal(displayedCurrentModel('codex', claudeModels)?.value, 'default')
})
